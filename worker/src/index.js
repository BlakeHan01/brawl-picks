// brawl-picks-api — Cloudflare Worker (Free plan, no KV/D1/Durable Objects).
//
// Self-contained: no imports from scripts/ or anywhere else in the repo.
// Endpoints:
//   GET /player/:tag   -> owned brawlers for one player (BS_API_KEY stays server-side)
//   GET /rotation      -> current event rotation, live from the Brawl Stars API
// Cron trigger (17 */3 * * *): dispatches the GitHub Actions stats workflow.
//
// Upstream: https://bsproxy.royaleapi.dev/v1 (RoyaleAPI proxy, fixed IP
// 45.79.218.79 — the existing "brawl-picks" key already allows only that IP).

export const BS_BASE = 'https://bsproxy.royaleapi.dev/v1';
export const GH_DISPATCH_URL =
  'https://api.github.com/repos/BlakeHan01/brawl-picks/actions/workflows/daily.yml/dispatches';

export const ALLOWED_ORIGINS = new Set([
  'https://blakehan01.github.io',
  'http://localhost:5173',
]);

const TAG_RE = /^[0289PYLQGRJCUV]{3,12}$/;
const PLAYER_CACHE_SECONDS = 60;
const ROTATION_CACHE_SECONDS = 120;

// --- Pure helpers (exported for tests) -----------------------------------

// Tag may come with or without '#', any case. Normalize: strip '#',
// uppercase, replace letter 'O' with digit '0'.
export function normalizeTag(raw) {
  return String(raw || '')
    .replace(/^#+/, '')
    .replace(/#/g, '')
    .toUpperCase()
    .replace(/O/g, '0');
}

export function isValidTag(normalized) {
  return TAG_RE.test(normalized);
}

// The API writes times as 20261120T080000.000Z.
// (Same 3-line conversion as parseTime in scripts/lib.mjs, copied here
// so the Worker stays self-contained.)
export function parseBrawlTime(s) {
  if (!s) return NaN;
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Date.parse(s);
}

const idsOnly = (list) =>
  (Array.isArray(list) ? list : []).map((x) => (x && typeof x === 'object' ? x.id : x)).filter((id) => id !== undefined && id !== null);

const listOf = (j) => (Array.isArray(j) ? j : j?.items || j?.list || []);

// Shape one upstream /players response into only what the site needs.
// Drops everything else (club, icons, skins, ...).
export function shapePlayer(upstream, fetchedAt) {
  const brawlers = (Array.isArray(upstream?.brawlers) ? upstream.brawlers : []).map((b) => {
    const out = {
      id: b?.id ?? null,
      power: b?.power ?? null,
      trophies: b?.trophies ?? null,
      rank: b?.rank ?? null,
      starPowers: idsOnly(b?.starPowers),
      gadgets: idsOnly(b?.gadgets),
      gears: idsOnly(b?.gears),
      hyperCharges: idsOnly(b?.hyperCharges),
    };
    if (b?.buffies) out.buffies = b.buffies;
    return out;
  });
  return {
    tag: `#${normalizeTag(upstream?.tag ?? '')}`,
    name: upstream?.name ?? null,
    trophies: upstream?.trophies ?? null,
    fetchedAt,
    brawlers,
  };
}

// Shape one upstream /events/rotation response. Same logic as parseRotation
// in scripts/fetch-rotation.mjs, minus the display fields (mode, modeColor,
// solo, img): the site adds those.
export function shapeRotation(upstream, fetchedAt) {
  const events = listOf(upstream)
    .map((it) => {
      const ev = it?.event || {};
      const start = parseBrawlTime(it?.startTime);
      const end = parseBrawlTime(it?.endTime);
      if (!ev.map || !Number.isFinite(end)) return null;
      return {
        slot: it?.slotId ?? null,
        id: ev.id ?? null,
        map: ev.map,
        modeId: ev.mode ?? null,
        modifiers: ev.modifiers || [],
        start: Number.isFinite(start) ? new Date(start).toISOString() : null,
        end: new Date(end).toISOString(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
  return { fetchedAt, events };
}

// --- HTTP plumbing ---------------------------------------------------------

function corsOrigin(origin) {
  return origin && ALLOWED_ORIGINS.has(origin) ? origin : null;
}

function jsonResponse(body, status, { maxAge, retryAfter } = {}) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (maxAge !== undefined) headers['Cache-Control'] = `public, max-age=${maxAge}`;
  if (retryAfter !== undefined) headers['Retry-After'] = String(retryAfter);
  return new Response(JSON.stringify(body), { status, headers });
}

function withCors(response, origin) {
  const allowed = corsOrigin(origin);
  if (!allowed) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', allowed);
  headers.set('Vary', 'Origin');
  return new Response(response.body, { status: response.status, headers });
}

function errorResponse(error, status, origin, extra) {
  return withCors(jsonResponse({ error }, status, extra), origin);
}

// Map an upstream HTTP status to our error shape. Returns null when ok.
function upstreamError(status, origin, what) {
  if (status === 404) return errorResponse('not_found', 404, origin);
  if (status === 403) {
    console.error(`[worker] upstream_auth on ${what}: key/IP problem`);
    return errorResponse('upstream_auth', 502, origin);
  }
  if (status === 429 || status === 503) {
    return errorResponse('busy', 503, origin, { retryAfter: 30 });
  }
  return errorResponse('upstream', 502, origin);
}

// --- Cache (Cache API, with a fetchedAt freshness check) -------------------

function cacheKey(request) {
  return new Request(request.url, { method: 'GET' });
}

async function getCached(request, maxAgeSeconds) {
  try {
    const cache = globalThis.caches?.default;
    if (!cache) return null;
    const hit = await cache.match(cacheKey(request));
    if (!hit) return null;
    const data = await hit.clone().json();
    const age = Date.now() - Date.parse(data?.fetchedAt || '');
    if (!Number.isFinite(age) || age >= maxAgeSeconds * 1000) {
      await cache.delete(cacheKey(request)).catch(() => {});
      return null;
    }
    return hit;
  } catch {
    return null;
  }
}

async function putCached(request, response) {
  try {
    const cache = globalThis.caches?.default;
    if (cache) await cache.put(cacheKey(request), response.clone());
  } catch {
    // Caching is best-effort; a cache failure must not fail the request.
  }
}

// --- Handlers ---------------------------------------------------------------

async function handlePlayer(request, env, origin) {
  const rawTag = decodeURIComponent(new URL(request.url).pathname.slice('/player/'.length));
  const tag = normalizeTag(rawTag);
  if (!isValidTag(tag)) return errorResponse('bad_tag', 400, origin);

  const cached = await getCached(request, PLAYER_CACHE_SECONDS);
  if (cached) return withCors(cached, origin);

  if (!env?.BS_API_KEY) {
    console.error('[worker] BS_API_KEY is not set');
    return errorResponse('upstream_auth', 502, origin);
  }
  let upstream;
  try {
    upstream = await fetch(`${BS_BASE}/players/%23${tag}`, {
      headers: { Authorization: `Bearer ${env.BS_API_KEY}`, Accept: 'application/json' },
    });
  } catch (e) {
    console.error('[worker] player fetch failed:', e?.message);
    return errorResponse('upstream', 502, origin);
  }
  if (!upstream.ok) return upstreamError(upstream.status, origin, 'player');
  let data;
  try {
    data = await upstream.json();
  } catch {
    return errorResponse('upstream', 502, origin);
  }
  const body = shapePlayer(data, new Date().toISOString());
  const response = jsonResponse(body, 200, { maxAge: PLAYER_CACHE_SECONDS });
  await putCached(request, response);
  return withCors(response, origin);
}

async function handleRotation(request, env, origin) {
  const cached = await getCached(request, ROTATION_CACHE_SECONDS);
  if (cached) return withCors(cached, origin);

  if (!env?.BS_API_KEY) {
    console.error('[worker] BS_API_KEY is not set');
    return errorResponse('upstream_auth', 502, origin);
  }
  let upstream;
  try {
    upstream = await fetch(`${BS_BASE}/events/rotation`, {
      headers: { Authorization: `Bearer ${env.BS_API_KEY}`, Accept: 'application/json' },
    });
  } catch (e) {
    console.error('[worker] rotation fetch failed:', e?.message);
    return errorResponse('upstream', 502, origin);
  }
  if (!upstream.ok) return upstreamError(upstream.status, origin, 'rotation');
  let data;
  try {
    data = await upstream.json();
  } catch {
    return errorResponse('upstream', 502, origin);
  }
  const body = shapeRotation(data, new Date().toISOString());
  const response = jsonResponse(body, 200, { maxAge: ROTATION_CACHE_SECONDS });
  await putCached(request, response);
  return withCors(response, origin);
}

export async function handleFetch(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');

  if (request.method === 'OPTIONS') {
    const headers = {};
    const allowed = corsOrigin(origin);
    if (allowed) {
      headers['Access-Control-Allow-Origin'] = allowed;
      headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type';
      headers['Access-Control-Max-Age'] = '86400';
      headers['Vary'] = 'Origin';
    }
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== 'GET') {
    return errorResponse('method_not_allowed', 405, origin);
  }

  if (url.pathname === '/rotation') return handleRotation(request, env, origin);
  if (url.pathname.startsWith('/player/')) return handlePlayer(request, env, origin);
  return errorResponse('not_found', 404, origin);
}

// --- Cron: dispatch the GitHub Actions stats run ----------------------------

export async function handleScheduled(env) {
  if (!env?.GH_TOKEN) {
    console.error('[worker] cron: GH_TOKEN is not set, skipping dispatch');
    return false;
  }
  let res;
  try {
    res = await fetch(GH_DISPATCH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'brawl-picks-worker',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: { stats: 'true' } }),
    });
  } catch (e) {
    console.error('[worker] cron: dispatch fetch failed:', e?.message);
    return false;
  }
  if (res.status !== 204) {
    console.error(`[worker] cron: dispatch failed, GitHub returned ${res.status}`);
    return false;
  }
  console.log('[worker] cron: dispatched daily.yml (stats=true)');
  return true;
}

export default {
  fetch: handleFetch,
  scheduled(event, env, ctx) {
    // scheduled() must return promptly; the dispatch runs in waitUntil.
    if (ctx?.waitUntil) ctx.waitUntil(handleScheduled(env));
    else return handleScheduled(env);
  },
};
