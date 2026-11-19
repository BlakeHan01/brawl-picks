#!/usr/bin/env node
// Daily data pull -> site/data/data.json
//
// Source A (no setup): Brawlify public API — map list, brawler list, and per-map
//   brawler win/use rates when Brawlify publishes them.
// Source B (optional): official Brawl Stars API. If BS_API_KEY is set, we sample
//   battle logs of top players and compute win rates per map ourselves. Used for
//   any map where Brawlify has no stats.
//
// Env:
//   BRAWLIFY_BASE   default https://api.brawlify.com/v1
//   BS_API_KEY      optional official API key (developer.brawlstars.com)
//   BS_API_BASE     default https://bsproxy.royaleapi.dev/v1 (key must allow IP 45.79.218.79)
//   BS_PLAYER_LIMIT how many top players' battle logs to sample (default 200)
//   OUT             default site/data/data.json

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRAWLIFY = process.env.BRAWLIFY_BASE || 'https://api.brawlify.com/v1';
const BS_KEY = process.env.BS_API_KEY || '';
const BS_BASE = process.env.BS_API_BASE || 'https://bsproxy.royaleapi.dev/v1';
const PLAYER_LIMIT = Number(process.env.BS_PLAYER_LIMIT || 200);
const OUT = resolve(ROOT, process.env.OUT || 'site/data/data.json');
const TOP_N = 20; // brawlers kept per map

// 3v3 modes that matter for ranked / draft. Showdown etc. are skipped.
const MODES = ['Gem Grab', 'Brawl Ball', 'Heist', 'Bounty', 'Knockout', 'Hot Zone'];
const modeKey = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const MODE_KEYS = new Set(MODES.map(modeKey));
const nameKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const log = (...a) => console.log('[fetch]', ...a);

async function getJSON(url, headers = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'brawl-picks/1.0', ...headers } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return await r.json();
    } catch (e) {
      last = e;
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

// ---------- Source A: Brawlify ----------
async function fromBrawlify() {
  const [brawlersJ, mapsJ, eventsJ] = await Promise.all([
    getJSON(`${BRAWLIFY}/brawlers`),
    getJSON(`${BRAWLIFY}/maps`),
    getJSON(`${BRAWLIFY}/events`).catch(() => null),
  ]);

  const brawlers = {};
  for (const b of listOf(brawlersJ)) {
    if (!b?.id || !b?.name) continue;
    brawlers[b.id] = {
      n: b.name,
      img: b.imageUrl2 || b.imageUrl || `https://cdn.brawlify.com/brawlers/borderless/${b.id}.png`,
      c: b.class?.name || '',
    };
  }

  const activeIds = new Set();
  for (const e of listOf(eventsJ)) {
    const id = e?.map?.id ?? e?.mapId;
    if (id) activeIds.add(id);
  }

  const maps = listOf(mapsJ).filter((m) => m && !m.disabled && MODE_KEYS.has(modeKey(m.gameMode?.name)));
  log(`brawlify: ${Object.keys(brawlers).length} brawlers, ${maps.length} 3v3 maps, ${activeIds.size} active`);

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
      src: stats.length ? 'brawlify' : null,
    };
  });
  return { brawlers, maps: out };
}

// ---------- Source B: official API battle-log sampling ----------
async function fromOfficial() {
  if (!BS_KEY) return null;
  const h = { authorization: `Bearer ${BS_KEY}` };
  const rank = await getJSON(`${BS_BASE}/rankings/global/players?limit=${PLAYER_LIMIT}`, h);
  const tags = listOf(rank).map((p) => p.tag).filter(Boolean);
  log(`official: sampling ${tags.length} battle logs`);

  const seen = new Set();
  const agg = new Map(); // mapKey -> { name, mode, total, b: Map<id,{w,n}> }
  const logs = await pool(tags, 6, (t) => getJSON(`${BS_BASE}/players/${encodeURIComponent(t)}/battlelog`, h));

  for (let i = 0; i < logs.length; i++) {
    for (const it of listOf(logs[i])) {
      const ev = it.event || {};
      const bt = it.battle || {};
      const mode = MODES.find((m) => modeKey(m) === modeKey(ev.mode || bt.mode));
      if (!mode || !ev.map || !Array.isArray(bt.teams) || bt.teams.length !== 2) continue;
      if (bt.result !== 'victory' && bt.result !== 'defeat') continue;
      const allTags = bt.teams.flat().map((p) => p.tag).sort().join(',');
      const key = `${it.battleTime}|${allTags}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const myTeam = bt.teams.findIndex((t) => t.some((p) => p.tag === tags[i]));
      if (myTeam < 0) continue;
      const mk = `${modeKey(mode)}|${nameKey(ev.map)}`;
      if (!agg.has(mk)) agg.set(mk, { name: ev.map, mode, total: 0, b: new Map() });
      const a = agg.get(mk);
      a.total++;
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
  return agg;
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
  const totalPicks = [...a.b.values()].reduce((s, x) => s + x.n, 0) || 1;
  return [...a.b.entries()].map(([id, { w, n }]) => ({
    id,
    wr: (100 * w) / n,
    ur: (100 * n * 6) / totalPicks, // % of teams that had this brawler
    n,
    score: (100 * (w + 10)) / (n + 20),
  }));
}

const r1 = (x) => Math.round(x * 10) / 10;

async function main() {
  const ranked = JSON.parse(await readFile(resolve(ROOT, 'scripts/ranked-maps.json'), 'utf8')).maps;
  const rankedKeys = new Set(ranked.map(nameKey));

  const A = await fromBrawlify();
  const B = await fromOfficial().catch((e) => (log('official source failed:', e.message), null));

  const maps = [];
  for (const m of A.maps) {
    let picks = [];
    let src = null;
    let sample = null;
    if (m.stats.length) {
      picks = scoreRates(m.stats);
      src = 'brawlify';
    } else if (B) {
      const a = B.get(`${modeKey(m.mode)}|${nameKey(m.name)}`);
      if (a && a.total >= 15) {
        picks = scoreCounts(a);
        src = 'official';
        sample = a.total;
      }
    }
    if (!picks.length) continue;
    picks = picks.filter((p) => A.brawlers[p.id]).sort((x, y) => y.score - x.score).slice(0, TOP_N);
    maps.push({
      id: m.id,
      name: m.name,
      mode: m.mode,
      modeColor: m.modeColor,
      modeIcon: m.modeIcon,
      img: m.img,
      ranked: rankedKeys.has(nameKey(m.name)),
      active: m.active,
      src,
      ...(sample ? { sample } : {}),
      // [brawlerId, winRate %, useRate %, score]
      picks: picks.map((p) => [p.id, r1(p.wr), r1(p.ur ?? 0), r1(p.score)]),
    });
  }

  maps.sort((a, b) => a.name.localeCompare(b.name));
  log(`maps with stats: ${maps.length} (ranked: ${maps.filter((m) => m.ranked).length})`);

  if (maps.length < 5) {
    // Don't overwrite the last good file with an empty one.
    console.error('[fetch] too few maps with stats — keeping previous data. Set BS_API_KEY to enable the official-API source.');
    process.exit(1);
  }

  const used = new Set(maps.flatMap((m) => m.picks.map((p) => p[0])));
  const brawlers = Object.fromEntries(Object.entries(A.brawlers).filter(([id]) => used.has(Number(id))));

  const data = {
    generatedAt: new Date().toISOString(),
    sources: [...new Set(maps.map((m) => m.src))],
    brawlers,
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
