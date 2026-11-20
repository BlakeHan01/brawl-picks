#!/usr/bin/env node
// Daily stats pull -> site/data/data.json
//
// Source: the official Brawl Stars API. We read the battle logs of the top players in
// several regions and keep only high-skill games:
//   - Ranked games (battle.type soloRanked / teamRanked), and
//   - trophy games where all players' brawlers have at least MIN_TROPHIES trophies
//     (this drops bot-filled and low-skill lobbies).
// Each run's counts are saved to data/daily/<date>.json; the site shows the last WINDOW_DAYS days.
//
// Env:
//   BS_API_KEY       official API key (developer.brawlstars.com), required
//   BS_API_BASE      default https://bsproxy.royaleapi.dev/v1 (key must allow IP 45.79.218.79)
//   BS_PLAYER_LIMIT  top players per region to sample (default 200)
//   BS_REGIONS       ranking regions (default global,us,kr,br,de,jp,mx,fr)
//   MIN_TROPHIES     min brawler trophies for every player in a trophy game (default 750)
//   WINDOW_DAYS      days of daily files to combine (default 14)
//   IMAGES           "off" to skip downloading images
//   OUT, DAILY_DIR   output paths (for tests)

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import {
  ROOT, BS_KEY, log, official, pool, listOf, parseTime, titleCase, nameKey,
  modeName, modeColor, RANKED_MODES, ensureImage,
} from './lib.mjs';

const PLAYER_LIMIT = Number(process.env.BS_PLAYER_LIMIT || 200);
const REGIONS = (process.env.BS_REGIONS || 'global,us,kr,br,de,jp,mx,fr').split(',').map((s) => s.trim()).filter(Boolean);
const MIN_TROPHIES = Number(process.env.MIN_TROPHIES || 750);
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 14);
const OUT = resolve(ROOT, process.env.OUT || 'site/data/data.json');
const DAILY_DIR = resolve(ROOT, process.env.DAILY_DIR || 'data/daily');
const STATE = join(DAILY_DIR, '..', 'state.json');

const TOP_N = 20; // brawlers kept per map
const MIN_MAP_BATTLES = 15; // fewer than this: map gets no picks
const PREFER_RANKED = 40; // ranked-only stats once a map has this many ranked games
const LOW_SAMPLE = 150; // below this the site labels the picks "few games"
const MIN_BRAWLER_GAMES = 10;
// Shrink toward 50% as if every brawler also had PRIOR_GAMES games at exactly 50%.
// Picking the top 5 out of ~80 brawlers rewards luck; this keeps small samples from winning.
const PRIOR_GAMES = 40;

const readJSON = (p) => readFile(p, 'utf8').then(JSON.parse, () => null);
const RANKED_TYPES = new Set(['soloRanked', 'teamRanked']);
// Per map and tier: n games, sw = games won by the sampled (top) player's side,
// b[brawlerId] = [games, wins] on the sampled side, then [games, wins] on the other side.
const blank = () => ({ n: 0, sw: 0, b: {} });

// ---------- 1. sample today's games ----------
export function tally(logs, tags, cutoff, day = { v: 2, battles: { ranked: 0, trophy: 0, skippedLowTrophy: 0 }, maps: {} }) {
  const seen = new Set();
  for (let i = 0; i < logs.length; i++) {
    for (const it of listOf(logs[i])) {
      const ev = it.event || {};
      const bt = it.battle || {};
      const t = parseTime(it.battleTime);
      if (cutoff && !(t > cutoff)) continue; // counted by an earlier run
      const mode = ev.mode && ev.mode !== 'unknown' ? ev.mode : bt.mode;
      const teams = bt.teams;
      if (!mode || !ev.map || !Array.isArray(teams) || teams.length !== 2) continue;
      if (teams[0].length < 2 || teams[0].length !== teams[1].length) continue;
      if (bt.result !== 'victory' && bt.result !== 'defeat') continue;
      const players = teams.flat();
      if (players.some((p) => !p?.tag || !p.brawler?.id)) continue;

      let tier;
      if (RANKED_TYPES.has(bt.type)) tier = 'r';
      else if (bt.type === 'ranked') {
        // "ranked" is the API's name for normal trophy games.
        if (players.some((p) => !(p.brawler.trophies >= MIN_TROPHIES))) { day.battles.skippedLowTrophy++; continue; }
        tier = 't';
      } else continue; // friendly, challenge, etc.

      const mine = teams.findIndex((tm) => tm.some((p) => p.tag === tags[i]));
      if (mine < 0) continue;
      const key = `${it.battleTime}|${players.map((p) => p.tag).sort().join(',')}`;
      if (seen.has(key)) continue; // the same game appears in several players' logs
      seen.add(key);

      const mk = `${mode}|${nameKey(ev.map)}`;
      const m = (day.maps[mk] ||= { id: ev.id ?? null, name: ev.map, mode, r: blank(), t: blank() });
      if (ev.id && !m.id) m.id = ev.id;
      const a = m[tier];
      const mineWon = bt.result === 'victory';
      a.n++;
      if (mineWon) a.sw++;
      day.battles[tier === 'r' ? 'ranked' : 'trophy']++;
      teams.forEach((team, ti) => {
        const side = ti === mine ? 0 : 2; // [games, wins] on the sampled player's side, then the other side
        const won = (ti === mine) === mineWon;
        for (const p of team) {
          const s = (a.b[p.brawler.id] ||= [0, 0, 0, 0]);
          s[side]++;
          if (won) s[side + 1]++;
        }
      });
    }
  }
  return day;
}

// ---------- 2. combine the window ----------
const r1 = (x) => Math.round(x * 10) / 10;

// Top players win most of their games, so raw win rates flatter whatever they pick.
// Each brawler is measured against how often its side won on this map instead:
// excess = wins above what that side's average would give. adjusted win % = 50 + excess per game.
export function buildMaps(days, rankedPool) {
  const sum = new Map();
  const add = (into, from) => {
    into.n += from.n;
    into.sw += from.sw;
    for (const [id, v] of Object.entries(from.b)) {
      const s = (into.b[id] ||= [0, 0, 0, 0]);
      for (let k = 0; k < 4; k++) s[k] += v[k];
    }
  };
  for (const d of days) {
    for (const [k, m] of Object.entries(d.maps)) {
      if (!m.r || m.r.sw === undefined) continue; // file from an older format
      const x = sum.get(k) || { id: m.id, name: m.name, mode: m.mode, r: blank(), t: blank() };
      if (m.id && !x.id) x.id = m.id;
      add(x.r, m.r); add(x.t, m.t);
      sum.set(k, x);
    }
  }

  const maps = [];
  for (const m of sum.values()) {
    let basis, a;
    if (m.r.n >= PREFER_RANKED) { basis = 'ranked'; a = m.r; }
    else {
      basis = m.r.n ? 'mixed' : 'trophy';
      a = blank(); add(a, m.r); add(a, m.t);
    }
    if (a.n < MIN_MAP_BATTLES) continue;
    const pS = a.sw / a.n; // how often the top players' side won here
    const picks = Object.entries(a.b)
      .map(([id, [gS, wS, gO, wO]]) => {
        const g = gS + gO;
        const excess = wS - gS * pS + (wO - gO * (1 - pS));
        return {
          id: Number(id),
          // estimated win % vs. an average pick: adjusted for skill, then shrunk toward 50%
          wr: 100 * (0.5 + excess / (g + PRIOR_GAMES)),
          ur: (100 * g) / (2 * a.n), // % of teams that had this brawler
          raw: 100 * (0.5 + excess / g),
          g,
        };
      })
      .filter((p) => p.g >= MIN_BRAWLER_GAMES)
      .sort((x, y) => y.wr - x.wr)
      .slice(0, TOP_N);
    if (!picks.length) continue;
    maps.push({
      id: m.id ?? `${m.mode}-${nameKey(m.name)}`,
      name: m.name,
      mode: modeName(m.mode),
      modeId: m.mode,
      modeColor: modeColor(m.mode),
      ranked: RANKED_MODES.has(m.mode) && (rankedPool.has(nameKey(m.name)) || m.r.n >= 5),
      basis,
      sample: a.n,
      rankedGames: m.r.n,
      topSideWin: r1(100 * pS),
      low: a.n < LOW_SAMPLE,
      // [brawlerId, estimated win %, use %, skill-adjusted win % before shrinking, games]
      picks: picks.map((p) => [p.id, r1(p.wr), r1(p.ur), r1(p.raw), p.g]),
    });
  }
  return maps.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- main ----------
async function main() {
  if (!BS_KEY) {
    console.error('[data] BS_API_KEY is not set, keeping previous data. Add the secret (see README).');
    process.exit(1);
  }
  const rankedPool = new Set(JSON.parse(await readFile(resolve(ROOT, 'scripts/ranked-maps.json'), 'utf8')).maps.map(nameKey));
  const started = Date.now();
  const state = (await readJSON(STATE)) || {};

  const brawlersJ = await official('/brawlers');
  const brawlers = {};
  for (const b of listOf(brawlersJ)) if (b?.id && b?.name) brawlers[b.id] = { n: titleCase(b.name) };
  if (!Object.keys(brawlers).length) throw new Error('no brawlers returned');

  const rankings = await pool(REGIONS, 4, (r) => official(`/rankings/${r}/players?limit=${PLAYER_LIMIT}`));
  const tags = [...new Set(rankings.flatMap((j) => listOf(j).map((p) => p.tag)).filter(Boolean))];
  log(`${Object.keys(brawlers).length} brawlers, sampling ${tags.length} battle logs from ${REGIONS.join(',')}`);
  const logs = await pool(tags, 10, (t) => official(`/players/${encodeURIComponent(t)}/battlelog`));
  log(`battle logs read: ${logs.filter(Boolean).length}/${tags.length}`);

  // Merge into today's file (the job may run more than once a day).
  await mkdir(DAILY_DIR, { recursive: true });
  const date = new Date(started).toISOString().slice(0, 10);
  const dayFile = join(DAILY_DIR, `${date}.json`);
  const prevDay = await readJSON(dayFile);
  const day = tally(logs, tags, state.lastRun ? Date.parse(state.lastRun) : 0, prevDay?.v === 2 ? prevDay : undefined);
  day.date = date;
  log(`today: ${day.battles.ranked} ranked + ${day.battles.trophy} high-trophy games (${day.battles.skippedLowTrophy} low-trophy games skipped)`);
  await writeFile(dayFile, JSON.stringify(day));
  await writeFile(STATE, JSON.stringify({ lastRun: new Date(started).toISOString() }, null, 1) + '\n');

  // Window: newest WINDOW_DAYS files; older ones are deleted.
  const files = (await readdir(DAILY_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const keep = files.slice(-WINDOW_DAYS);
  for (const f of files.slice(0, -WINDOW_DAYS)) await unlink(join(DAILY_DIR, f));
  const days = (await Promise.all(keep.map((f) => readJSON(join(DAILY_DIR, f))))).filter(Boolean);
  const maps = buildMaps(days, rankedPool);
  log(`maps with picks: ${maps.length} (ranked pool: ${maps.filter((m) => m.ranked).length}, ranked-only stats: ${maps.filter((m) => m.basis === 'ranked').length})`);

  if (maps.length < 5) {
    console.error(`[data] too few maps with picks (${maps.length}), keeping previous data.`);
    process.exit(1);
  }

  const used = new Set(maps.flatMap((m) => m.picks.map((p) => p[0])));
  const B = {};
  await pool([...used], 8, async (id) => {
    if (!brawlers[id]) return;
    B[id] = { ...brawlers[id], img: await ensureImage('brawlers', id) };
  });
  await pool(maps, 8, async (m) => { m.img = typeof m.id === 'number' ? await ensureImage('maps', m.id) : null; });
  for (const m of maps) m.picks = m.picks.filter((p) => B[p[0]]);

  const totals = days.filter((d) => d.v === 2).reduce((s, d) => ({ ranked: s.ranked + d.battles.ranked, trophy: s.trophy + d.battles.trophy }), { ranked: 0, trophy: 0 });
  const data = {
    generatedAt: new Date().toISOString(),
    window: { days: days.length, from: keep[0]?.slice(0, 10), to: date },
    minTrophies: MIN_TROPHIES,
    battles: totals,
    brawlers: B,
    maps,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(data));
  log(`wrote ${OUT} (${(JSON.stringify(data).length / 1024).toFixed(0)} KB)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('[data]', e.message);
    process.exit(1);
  });
}
