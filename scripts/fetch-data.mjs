#!/usr/bin/env node
// Daily data pull -> site/data/data.json
//
// Primary source: the official Brawl Stars API (needs BS_API_KEY). We sample the
//   battle logs of top players, keep 3v3 games, and compute per-map win rates.
// Optional extra: Brawlify's public API (map art, mode colours, and per-map stats
//   when it publishes them). Brawlify blocks some datacenter IPs (including
//   GitHub Actions), so everything works without it.
//
// Env:
//   BS_API_KEY      official API key (developer.brawlstars.com)
//   BS_API_BASE     default https://bsproxy.royaleapi.dev/v1 (key must allow IP 45.79.218.79)
//   BS_PLAYER_LIMIT top players per region to sample (default 200)
//   BS_REGIONS      comma list of ranking regions (default global,us,kr,br,de,jp)
//   BRAWLIFY_BASE   default https://api.brawlapi.com/v1 ("off" to skip)
//   OUT             default site/data/data.json

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRAWLIFY = process.env.BRAWLIFY_BASE || 'https://api.brawlapi.com/v1';
const BS_KEY = process.env.BS_API_KEY || '';
const BS_BASE = process.env.BS_API_BASE || 'https://bsproxy.royaleapi.dev/v1';
const PLAYER_LIMIT = Number(process.env.BS_PLAYER_LIMIT || 200);
const REGIONS = (process.env.BS_REGIONS || 'global,us,kr,br,de,jp').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = resolve(ROOT, process.env.OUT || 'site/data/data.json');
const TOP_N = 20; // brawlers kept per map
const MIN_BATTLES = 15; // maps with fewer sampled battles are skipped

// 3v3 modes that matter for ranked / draft. Showdown etc. are skipped.
const MODES = ['Gem Grab', 'Brawl Ball', 'Heist', 'Bounty', 'Knockout', 'Hot Zone'];
const MODE_COLORS = { gemgrab: '#9a3df4', brawlball: '#8ca0e0', heist: '#d65cd3', bounty: '#24d6ff', knockout: '#f7831c', hotzone: '#e33b50' };
const modeKey = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const MODE_KEYS = new Set(MODES.map(modeKey));
const nameKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const titleCase = (s) => String(s).toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, a, b) => a + b.toUpperCase()).replace(/8-bit/i, '8-Bit');

const log = (...a) => console.log('[fetch]', ...a);

async function getJSON(url, headers = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'brawl-picks/1.0', ...headers } });
      if (r.status === 404) return null;
      if (r.status === 403 || r.status === 401) throw Object.assign(new Error(`${r.status} ${r.statusText}`), { fatal: true });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return await r.json();
    } catch (e) {
      last = e;
      if (e.fatal) break;
      await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    }
  }
  throw new Error(`GET ${url} failed: ${last?.message}`);
}

async function pool(items, n, fn) {
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

const listOf = (j) => (Array.isArray(j) ? j : j?.list || j?.items || j?.active || []);
const num = (v) => (typeof v === 'number' ? v : v == null ? NaN : Number(v));

// ---------- Optional: Brawlify ----------
async function fromBrawlify() {
  if (BRAWLIFY === 'off') return null;
  const [brawlersJ, mapsJ, eventsJ] = await Promise.all([
    getJSON(`${BRAWLIFY}/brawlers`),
    getJSON(`${BRAWLIFY}/maps`),
    getJSON(`${BRAWLIFY}/events`).catch(() => null),
  ]);

  const brawlers = {};
  for (const b of listOf(brawlersJ)) {
    if (!b?.id || !b?.name) continue;
    brawlers[b.id] = { n: b.name, img: b.imageUrl2 || b.imageUrl, c: b.class?.name || '' };
  }

  const activeIds = new Set();
  for (const e of listOf(eventsJ)) {
    const id = e?.map?.id ?? e?.mapId;
    if (id) activeIds.add(id);
  }

  const maps = listOf(mapsJ).filter((m) => m && !m.disabled && MODE_KEYS.has(modeKey(m.gameMode?.name)));
  const details = await pool(maps, 8, (m) => getJSON(`${BRAWLIFY}/maps/${m.id}`));

  const out = maps.map((m, i) => {
    const d = details[i] || {};
    const stats = (d.stats || m.stats || [])
      .map((s) => ({
        id: typeof s.brawler === 'object' ? s.brawler?.id : s.brawler ?? s.brawlerId ?? s.id,
        wr: num(s.winRate),
        ur: num(s.useRate),
      }))
      .filter((s) => s.id && Number.isFinite(s.wr));
    return {
      id: m.id,
      name: m.name,
      mode: m.gameMode?.name,
      modeColor: m.gameMode?.color || null,
      modeIcon: m.gameMode?.imageUrl || null,
      img: m.imageUrl || null,
      active: activeIds.has(m.id),
      stats,
    };
  });
  log(`brawlify: ${Object.keys(brawlers).length} brawlers, ${out.length} maps, ${out.filter((m) => m.stats.length).length} with stats`);
  return { brawlers, maps: out };
}

// ---------- Primary: official API battle-log sampling ----------
async function fromOfficial() {
  if (!BS_KEY) return null;
  const h = { authorization: `Bearer ${BS_KEY}` };

  const brawlersJ = await getJSON(`${BS_BASE}/brawlers`, h);
  const brawlers = {};
  for (const b of listOf(brawlersJ)) {
    if (b?.id && b?.name) brawlers[b.id] = { n: titleCase(b.name), img: `https://cdn.brawlify.com/brawlers/borderless/${b.id}.png`, c: '' };
  }

  const rankings = await pool(REGIONS, 3, (r) => getJSON(`${BS_BASE}/rankings/${r}/players?limit=${PLAYER_LIMIT}`, h));
  const tags = [...new Set(rankings.flatMap((j) => listOf(j).map((p) => p.tag)).filter(Boolean))];
  log(`official: ${Object.keys(brawlers).length} brawlers, sampling ${tags.length} battle logs`);

  const seen = new Set();
  const agg = new Map(); // mapKey -> { id, name, mode, total, b: Map<id,{w,n}> }
  const logs = await pool(tags, 8, (t) => getJSON(`${BS_BASE}/players/${encodeURIComponent(t)}/battlelog`, h));

  for (let i = 0; i < logs.length; i++) {
    for (const it of listOf(logs[i])) {
      const ev = it.event || {};
      const bt = it.battle || {};
      const mode = MODES.find((m) => modeKey(m) === modeKey(ev.mode || bt.mode));
      if (!mode || !ev.map || !Array.isArray(bt.teams) || bt.teams.length !== 2) continue;
      if (bt.result !== 'victory' && bt.result !== 'defeat') continue;
      const key = `${it.battleTime}|${bt.teams.flat().map((p) => p.tag).sort().join(',')}`;
      if (seen.has(key)) continue; // the same game shows up in several players' logs
      seen.add(key);

      const myTeam = bt.teams.findIndex((t) => t.some((p) => p.tag === tags[i]));
      if (myTeam < 0) continue;
      const mk = `${modeKey(mode)}|${nameKey(ev.map)}`;
      if (!agg.has(mk)) agg.set(mk, { id: ev.id || null, name: ev.map, mode, total: 0, ranked: false, b: new Map() });
      const a = agg.get(mk);
      a.total++;
      if (/ranked/i.test(bt.type || '')) a.ranked = true;
      bt.teams.forEach((team, ti) => {
        const won = (ti === myTeam) === (bt.result === 'victory');
        for (const p of team) {
          const id = p.brawler?.id;
          if (!id) continue;
          const s = a.b.get(id) || { w: 0, n: 0 };
          s.n++;
          if (won) s.w++;
          a.b.set(id, s);
        }
      });
    }
  }
  log(`official: ${seen.size} battles on ${agg.size} maps`);
  return { brawlers, agg, battles: seen.size };
}

// ---------- scoring ----------
// Brawlify gives percentages without sample sizes, so use rate stands in for
// confidence: rarely-picked brawlers are pulled toward the map average.
function scoreRates(stats) {
  const useSum = stats.reduce((s, x) => s + (Number.isFinite(x.ur) ? x.ur : 0), 0);
  const meanUse = useSum / Math.max(1, stats.length) || 1;
  const meanWr = useSum
    ? stats.reduce((s, x) => s + x.wr * (x.ur || 0), 0) / useSum
    : stats.reduce((s, x) => s + x.wr, 0) / Math.max(1, stats.length);
  const k = meanUse * 0.5;
  return stats.map((x) => {
    const u = Number.isFinite(x.ur) ? x.ur : meanUse;
    return { ...x, score: (x.wr * u + meanWr * k) / (u + k) };
  });
}

// Official sample has real counts: Bayesian shrink toward 50% with a prior of 20 games.
function scoreCounts(a) {
  return [...a.b.entries()].map(([id, { w, n }]) => ({
    id,
    wr: (100 * w) / n,
    ur: (100 * n) / (a.total * 2), // % of teams that picked this brawler
    n,
    score: (100 * (w + 10)) / (n + 20),
  }));
}

const r1 = (x) => Math.round(x * 10) / 10;

async function main() {
  const ranked = JSON.parse(await readFile(resolve(ROOT, 'scripts/ranked-maps.json'), 'utf8')).maps;
  const rankedKeys = new Set(ranked.map(nameKey));

  const [A, B] = await Promise.all([
    fromBrawlify().catch((e) => (log('brawlify unavailable:', e.message), null)),
    fromOfficial().catch((e) => (log('official API failed:', e.message), null)),
  ]);
  if (!BS_KEY) log('BS_API_KEY not set — official API source skipped');

  const brawlers = { ...(B?.brawlers || {}) };
  for (const [id, b] of Object.entries(A?.brawlers || {})) brawlers[id] = { ...brawlers[id], ...b };

  // Brawlify map metadata by name, for art and colours on official-API maps.
  const meta = new Map((A?.maps || []).map((m) => [`${modeKey(m.mode)}|${nameKey(m.name)}`, m]));
  const keys = new Set([...meta.keys(), ...(B?.agg.keys() || [])]);

  const maps = [];
  for (const k of keys) {
    const m = meta.get(k);
    const a = B?.agg.get(k);
    let picks = [];
    let src = null;
    if (a && a.total >= MIN_BATTLES) {
      picks = scoreCounts(a);
      src = 'official';
    } else if (m?.stats.length) {
      picks = scoreRates(m.stats);
      src = 'brawlify';
    }
    if (!picks.length) continue;
    picks = picks.filter((p) => brawlers[p.id]).sort((x, y) => y.score - x.score).slice(0, TOP_N);
    const name = m?.name || a.name;
    const mode = m?.mode || a.mode;
    const id = m?.id || a?.id || k;
    maps.push({
      id,
      name,
      mode,
      modeColor: m?.modeColor || MODE_COLORS[modeKey(mode)] || null,
      modeIcon: m?.modeIcon || null,
      img: m?.img || (typeof id === 'number' ? `https://cdn.brawlify.com/maps/regular/${id}.png` : null),
      ranked: rankedKeys.has(nameKey(name)) || !!a?.ranked,
      active: !!m?.active || !!a, // played in the last few days = in rotation
      src,
      ...(src === 'official' ? { sample: a.total } : {}),
      // [brawlerId, winRate %, useRate %, score]
      picks: picks.map((p) => [p.id, r1(p.wr), r1(p.ur ?? 0), r1(p.score)]),
    });
  }

  maps.sort((a, b) => a.name.localeCompare(b.name));
  log(`maps with stats: ${maps.length} (ranked: ${maps.filter((m) => m.ranked).length})`);

  if (maps.length < 5) {
    // Don't overwrite the last good file with an empty one.
    console.error(`[fetch] too few maps with stats (${maps.length}) — keeping previous data.` + (BS_KEY ? '' : ' Add the BS_API_KEY secret (see README).'));
    process.exit(1);
  }

  const used = new Set(maps.flatMap((m) => m.picks.map((p) => String(p[0]))));
  const data = {
    generatedAt: new Date().toISOString(),
    sources: [...new Set(maps.map((m) => m.src))],
    battles: B?.battles || null,
    brawlers: Object.fromEntries(Object.entries(brawlers).filter(([id]) => used.has(id))),
    maps,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(data));
  log(`wrote ${OUT} (${(JSON.stringify(data).length / 1024).toFixed(0)} KB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
