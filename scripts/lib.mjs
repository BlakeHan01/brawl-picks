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

// ---------- game modes (shared with the site) ----------
export { MODE_INFO, RANKED_MODES, modeName, isSoloMode, modeColor } from '../site/modes.js';

// ---------- images (self-hosted copies of Brawlify CDN art) ----------
const exists = (p) => access(p).then(() => true, () => false);

// kind: 'brawlers' | 'maps' | 'star-powers-framed' | 'gadgets-framed' | 'gears'. Returns the site-relative path, or null if unavailable.
export async function ensureImage(kind, id) {
  const rel = `img/${kind}/${id}.png`;
  const file = resolve(ROOT, 'site', rel);
  if (await exists(file)) return rel;
  if (process.env.IMAGES === 'off') return null;
  // star powers / gadgets: the "regular" art includes the in-game badge frame
  const path = { brawlers: 'brawlers/borderless', maps: 'maps/regular', 'star-powers-framed': 'star-powers/regular', 'gadgets-framed': 'gadgets/regular', gears: 'gears/regular' }[kind];
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
