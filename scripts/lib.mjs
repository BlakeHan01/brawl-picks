// Shared helpers for the data scripts.
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BS_KEY = process.env.BS_API_KEY || '';
// RoyaleAPI's proxy has a fixed IP (45.79.218.79), so one API key works from any runner.
export const BS_BASE = process.env.BS_API_BASE || 'https://bsproxy.royaleapi.dev/v1';
export const CDN = process.env.IMG_CDN || 'https://cdn.brawlify.com';

export const log = (...a) => console.log('[data]', ...a);

export async function getJSON(url, headers = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'brawl-picks/1.0', ...headers } });
      if (r.status === 404) return null;
      if (r.status === 403 || r.status === 401) {
        const body = await r.text().catch(() => '');
        throw Object.assign(new Error(`${r.status} ${body.slice(0, 200)}`), { fatal: true });
      }
      if (r.status === 429 || r.status === 503) {
        // throttled: wait longer before retrying
        await new Promise((res) => setTimeout(res, 3000 * (i + 1)));
        throw new Error(`${r.status} throttled`);
      }
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return await r.json();
    } catch (e) {
      last = e;
      if (e.fatal) break;
      await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    }
  }
  throw Object.assign(new Error(`GET ${url} failed: ${last?.message}`), { fatal: !!last?.fatal });
}

export const official = (path) => getJSON(`${BS_BASE}${path}`, { authorization: `Bearer ${BS_KEY}` });

// Run fn over items with at most n in flight. Failures become null.
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; log('warn:', e.message); }
      }
    }),
  );
  return out;
}

export const listOf = (j) => (Array.isArray(j) ? j : j?.items || j?.list || []);

// The API writes times as 20261120T080000.000Z.
export function parseTime(s) {
  if (!s) return NaN;
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Date.parse(s);
}

export const titleCase = (s) => String(s).toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, a, b) => a + b.toUpperCase());
export const nameKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- game modes ----------
// key = official API mode id. Unknown modes still work: name is derived from the id.
export const MODE_INFO = {
  gemGrab: ['Gem Grab', '#a64cf0'],
  brawlBall: ['Brawl Ball', '#8ca0e0'],
  heist: ['Heist', '#d65cd3'],
  bounty: ['Bounty', '#24d6ff'],
  knockout: ['Knockout', '#f7831c'],
  hotZone: ['Hot Zone', '#e33b50'],
  wipeout: ['Wipeout', '#3fb4ff'],
  brawlHockey: ['Brawl Hockey', '#4fd1e8'],
  airHockey: ['Air Hockey', '#4fd1e8'],
  brawlArena: ['Brawl Arena', '#c94fe0'],
  deathmatch: ['Deathmatch', '#e84f6a'],
  deathmatch5V5: ['Deathmatch 5v5', '#e84f6a'],
  treasureHunt: ['Treasure Hunt', '#e8c84f'],
  bombHeist: ['Bomb Heist', '#d65cd3'],
  killConfirmed: ['Kill Confirmed', '#e8704f'],
  basketBrawl: ['Basket Brawl', '#ff9a3c'],
  volleyBrawl: ['Volley Brawl', '#ffd23c'],
  payload: ['Payload', '#e5b53a'],
  presentPlunder: ['Present Plunder', '#e0533d'],
  holdTheTrophy: ['Hold the Trophy', '#e8b33c'],
  trophyThieves: ['Trophy Thieves', '#e8b33c'],
  gemGrab5V5: ['Gem Grab 5v5', '#a64cf0'],
  brawlBall5V5: ['Brawl Ball 5v5', '#8ca0e0'],
  knockout5V5: ['Knockout 5v5', '#f7831c'],
  wipeout5V5: ['Wipeout 5v5', '#3fb4ff'],
  soloShowdown: ['Solo Showdown', '#81d621'],
  duoShowdown: ['Duo Showdown', '#81d621'],
  trioShowdown: ['Trio Showdown', '#81d621'],
  duels: ['Duels', '#ff3c5c'],
};
// Modes that make up the Ranked map pool.
export const RANKED_MODES = new Set(['gemGrab', 'brawlBall', 'heist', 'bounty', 'knockout', 'hotZone']);

export function modeName(id) {
  if (MODE_INFO[id]) return MODE_INFO[id][0];
  return String(id || 'Unknown').replace(/(\d)V(\d)/g, '$1v$2').replace(/([a-z])([A-Z]|\d+v\d+)/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}
// Modes with no fixed teams: the site has no picks for these.
export const isSoloMode = (id) => /showdown|duels|bossFight|roboRumble|bigGame/i.test(String(id));
export const modeColor = (id) => MODE_INFO[id]?.[1] || '#9a8fc0';

// ---------- images (self-hosted copies of Brawlify CDN art) ----------
const exists = (p) => access(p).then(() => true, () => false);

// kind: 'brawlers' | 'maps' | 'star-powers' | 'gadgets' | 'gears'. Returns the site-relative path, or null if unavailable.
export async function ensureImage(kind, id) {
  const rel = `img/${kind}/${id}.png`;
  const file = resolve(ROOT, 'site', rel);
  if (await exists(file)) return rel;
  if (process.env.IMAGES === 'off') return null;
  const path = { brawlers: 'brawlers/borderless', maps: 'maps/regular', 'star-powers': 'star-powers/borderless', gadgets: 'gadgets/borderless', gears: 'gears/regular' }[kind];
  if (!path) return null;
  const src = `${CDN}/${path}/${id}.png`;
  try {
    const r = await fetch(src, { headers: { 'user-agent': 'brawl-picks/1.0' } });
    if (!r.ok || !String(r.headers.get('content-type')).startsWith('image/')) return null;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(await r.arrayBuffer()));
    return rel;
  } catch {
    return null;
  }
}
