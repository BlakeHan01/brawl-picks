// Brawl Picks Worker (Cloudflare Workers, free plan).
//   GET /player/:tag  -> the player's brawlers (ids only), for Curated pick
//   GET /rotation     -> current event rotation, live
//   cron              -> starts the GitHub stats workflow on time
// Secrets: BS_API_KEY (Brawl Stars API, key allows the RoyaleAPI proxy IP 45.79.218.79), GH_TOKEN.

const TAG_RE = /^[0289PYLQGRJCUV]{3,12}$/;

export function normalizeTag(raw) {
  const t = decodeURIComponent(String(raw || '')).trim().replace(/^#/, '').toUpperCase().replace(/O/g, '0');
  return TAG_RE.test(t) ? t : null;
}

// The API writes times as 20261120T080000.000Z.
export function parseTime(s) {
  const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/);
  const ms = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const ids = (xs) => (Array.isArray(xs) ? xs.map((x) => x?.id).filter(Boolean) : []);

// Keep only what the site needs: no club, icons, skins or other players.
export function shapePlayer(p, now = new Date()) {
  return {
    tag: p.tag,
    name: p.name,
    trophies: p.trophies,
    fetchedAt: now.toISOString(),
    brawlers: (p.brawlers || []).map((b) => {
      const out = {
        id: b.id,
        power: b.power,
        trophies: b.trophies,
        rank: b.rank,
        starPowers: ids(b.starPowers),
        gadgets: ids(b.gadgets),
        gears: ids(b.gears),
        hyperCharges: ids(b.hyperCharges),
      };
      if (b.buffies && typeof b.buffies === 'object') {
        out.buffies = { gadget: !!b.buffies.gadget, starPower: !!b.buffies.starPower, hyperCharge: !!b.buffies.hyperCharge };
      }
      return out;
    }),
  };
}

export function shapeRotation(list, now = new Date()) {
  const items = Array.isArray(list) ? list : list?.items || [];
  const events = items
    .map((it) => {
      const ev = it?.event || {};
      const end = parseTime(it?.endTime);
      if (!ev.map || !end) return null;
      return { slot: it.slotId ?? null, id: ev.id ?? null, map: ev.map, modeId: ev.mode, start: parseTime(it.startTime), end, modifiers: ev.modifiers || [] };
    })
    .filter(Boolean)
    .sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
  return { fetchedAt: now.toISOString(), events };
}

function cors(req, env) {
  const origin = req.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = { Vary: 'Origin' };
  if (origin && allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function json(body, status, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra } });
}

async function upstream(env, path) {
  const r = await fetch(`${env.BS_API_BASE || 'https://bsproxy.royaleapi.dev/v1'}${path}`, {
    headers: { Authorization: `Bearer ${env.BS_API_KEY}`, Accept: 'application/json' },
  });
  if (r.ok) return { ok: true, data: await r.json() };
  if (r.status === 404) return { ok: false, res: json({ error: 'not_found' }, 404) };
  if (r.status === 403) { console.log('upstream 403: check BS_API_KEY and its allowed IP'); return { ok: false, res: json({ error: 'upstream_auth' }, 502) }; }
  if (r.status === 429 || r.status === 503) return { ok: false, res: json({ error: 'busy' }, 503, { 'Retry-After': '30' }) };
  console.log(`upstream ${r.status}`);
  return { ok: false, res: json({ error: 'upstream' }, 502) };
}

// Cache successful GET responses for `ttl` seconds (Cache API is free; no KV needed).
async function cached(req, ctx, key, ttl, produce) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(new URL(key, req.url).toString());
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const res = await produce();
  if (res.status === 200) {
    res.headers.set('Cache-Control', `public, max-age=${ttl}`);
    if (cache) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  }
  return res;
}

export async function handle(req, env, ctx) {
  const h = cors(req, env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  const withCors = (res) => { for (const [k, v] of Object.entries(h)) res.headers.set(k, v); return res; };
  if (req.method !== 'GET') return withCors(json({ error: 'method_not_allowed' }, 405));

  const path = new URL(req.url).pathname;
  let m;
  if ((m = path.match(/^\/player\/([^/]+)$/))) {
    const tag = normalizeTag(m[1]);
    if (!tag) return withCors(json({ error: 'bad_tag' }, 400));
    const res = await cached(req, ctx, `/__cache/player/${tag}`, 60, async () => {
      const u = await upstream(env, `/players/%23${tag}`);
      return u.ok ? json(shapePlayer(u.data), 200) : u.res;
    });
    return withCors(new Response(res.body, res));
  }
  if (path === '/rotation') {
    const res = await cached(req, ctx, '/__cache/rotation', 120, async () => {
      const u = await upstream(env, '/events/rotation');
      return u.ok ? json(shapeRotation(u.data), 200) : u.res;
    });
    return withCors(new Response(res.body, res));
  }
  return withCors(json({ error: 'not_found' }, 404));
}

// Cron: ask GitHub to run the stats workflow now.
export async function dispatchStats(env) {
  const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/daily.yml/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'brawl-picks-worker', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs: { stats: 'true' } }),
  });
  if (r.status !== 204) console.log(`workflow dispatch failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status;
}

export default {
  fetch: (req, env, ctx) => handle(req, env, ctx),
  scheduled: (event, env, ctx) => ctx.waitUntil(dispatchStats(env)),
};
