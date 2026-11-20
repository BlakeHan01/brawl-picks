#!/usr/bin/env node
// Stats pull (every 3 hours) -> site/data/data.json
//
// Source: the official Brawl Stars API. We read battle logs and keep only high-skill games:
//   - Ranked games (battle.type soloRanked / teamRanked). In these, each player's
//     brawler.trophies holds their Ranked rank (1-22: 16+ = Legendary, 19+ = Masters, 22 = Pro).
//   - trophy games where every player's brawler has at least MIN_TROPHIES trophies
//     (this drops bot-filled and low-skill lobbies).
// Players: the top BS_PLAYER_LIMIT in each region, then (crawl) up to CRAWL_LIMIT Legendary+
// players met in those players' Ranked games.
// Games are filed by the day they were played in data/daily/<date>.json; the site uses the last
// WINDOW_DAYS days. The API only keeps a player's last 25 games, so a backfill (BACKFILL_DAYS) reads
// many players to reach older games; older days come out thinner.
//
// Two rankings are written per map (shadow run):
//   picks   current: all Ranked games (or high-trophy games), skill-adjusted, shrunk to 50%
//   shadow  new: Masters+ / Legendary+ games when there are enough, and pick rate informs the prior
//
// Env:
//   BS_API_KEY       official API key (developer.brawlstars.com), required
//   BS_API_BASE      default https://bsproxy.royaleapi.dev/v1 (key must allow IP 45.79.218.79)
//   BS_PLAYER_LIMIT  top players per region (default 200)
//   BS_REGIONS       ranking regions (default global,us,kr,br,de,jp,mx,fr)
//   CRAWL_LIMIT      extra Legendary+ players to read per run (default 3000, 0 = off)
//   BACKFILL_DAYS    one-off: rebuild the last n day files from every game in the logs read
//   MIN_TROPHIES     min brawler trophies for every player in a trophy game (default 750)
//   WINDOW_DAYS      days of daily files to combine (default 14)
//   BRAWLIFY_BASE    Brawlify API for brawler classes (default https://api.brawlapi.com/v1, "off" to skip)
//   IMAGES           "off" to skip downloading images
//   OUT, DAILY_DIR   output paths (for tests)

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import {
  ROOT, BS_KEY, log, official, getJSON, pool, listOf, parseTime, titleCase, nameKey,
  modeName, modeColor, RANKED_MODES, ensureImage,
} from './lib.mjs';

const PLAYER_LIMIT = Number(process.env.BS_PLAYER_LIMIT || 200);
const REGIONS = (process.env.BS_REGIONS || 'global,us,kr,br,de,jp,mx,fr').split(',').map((s) => s.trim()).filter(Boolean);
const CRAWL_LIMIT = Number(process.env.CRAWL_LIMIT ?? 3000);
const BRAWLIFY = process.env.BRAWLIFY_BASE || 'https://api.brawlapi.com/v1';
const MIN_TROPHIES = Number(process.env.MIN_TROPHIES || 750);
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 14);
const BACKFILL_DAYS = Math.min(Number(process.env.BACKFILL_DAYS || 0), WINDOW_DAYS);
const OUT = resolve(ROOT, process.env.OUT || 'site/data/data.json');
const DAILY_DIR = resolve(ROOT, process.env.DAILY_DIR || 'data/daily');
const STATE = join(DAILY_DIR, '..', 'state.json');

export const LEGENDARY = 16;
export const MASTERS = 19;
const TOP_N = 20; // brawlers kept per map
const MIN_MAP_BATTLES = 15; // fewer than this: map gets no picks
const PREFER_RANKED = 40; // ranked-only stats once a map has this many ranked games
const PREFER_LEGENDARY = 40; // new ranking: Legendary+ only from this many games
const PREFER_MASTERS = 150; // new ranking: Masters+ only from this many games
const LOW_SAMPLE = 150; // below this the site labels the picks "few games"
const MIN_BRAWLER_GAMES = 10;
// Shrink toward the prior as if every brawler also had PRIOR_GAMES games at the prior.
// Picking the top 5 out of ~80 brawlers rewards luck; this keeps small samples from winning.
const PRIOR_GAMES = 40;
// New ranking: the prior is not flat 50%. Brawlers good players pick a lot on this map start a
// little higher, rare ones a little lower: PICK_WEIGHT points per e-fold of pick rate vs. the median.
const PICK_WEIGHT = 2;
const DAY_VERSION = 3;

const readJSON = (p) => readFile(p, 'utf8').then(JSON.parse, () => null);
const RANKED_TYPES = new Set(['soloRanked', 'teamRanked']);
// Per map and group: n games, sw = games won by the sampled player's side,
// b[brawlerId] = [games, wins] on the sampled side, then [games, wins] on the other side.
// Groups: r = all Ranked, rL = Ranked with every player Legendary+, rM = Masters+, t = high-trophy.
const GROUPS = ['r', 'rL', 'rM', 't'];
const blank = () => ({ n: 0, sw: 0, b: {} });
const emptyDay = () => ({ v: DAY_VERSION, battles: { ranked: 0, legendary: 0, masters: 0, trophy: 0, skippedLowTrophy: 0, players: 0 }, maps: {} });

function addGame(a, teams, mine, mineWon) {
  a.n++;
  if (mineWon) a.sw++;
  teams.forEach((team, ti) => {
    const side = ti === mine ? 0 : 2;
    const won = (ti === mine) === mineWon;
    for (const p of team) {
      const s = (a.b[p.brawler.id] ||= [0, 0, 0, 0]);
      s[side]++;
      if (won) s[side + 1]++;
    }
  });
}

// ---------- 1. sample games ----------
// Single-day form (tests): every game goes into `day`.
export function tally(logs, tags, cutoff, day = emptyDay()) {
  tallyInto(logs, tags, cutoff, () => day);
  return day;
}

// pick(timeMs) returns the day object a game belongs to, or null to skip it.
export function tallyInto(logs, tags, cutoff, pick) {
  const seen = new Set();
  for (let i = 0; i < logs.length; i++) {
    for (const it of listOf(logs[i])) {
      const ev = it.event || {};
      const bt = it.battle || {};
      const t = parseTime(it.battleTime);
      if (cutoff && !(t > cutoff)) continue; // counted by an earlier run
      const day = pick(t);
      if (!day) continue;
      const mode = ev.mode && ev.mode !== 'unknown' ? ev.mode : bt.mode;
      const teams = bt.teams;
      if (!mode || !ev.map || !Array.isArray(teams) || teams.length !== 2) continue;
      if (teams[0].length < 2 || teams[0].length !== teams[1].length) continue;
      if (bt.result !== 'victory' && bt.result !== 'defeat') continue;
      const players = teams.flat();
      if (players.some((p) => !p?.tag || !p.brawler?.id)) continue;

      let groups;
      if (RANKED_TYPES.has(bt.type)) {
        const minRank = Math.min(...players.map((p) => Number(p.brawler.trophies) || 0));
        groups = ['r'];
        if (minRank >= LEGENDARY) groups.push('rL');
        if (minRank >= MASTERS) groups.push('rM');
      } else if (bt.type === 'ranked') {
        // "ranked" is the API's name for normal trophy games.
        if (players.some((p) => !(p.brawler.trophies >= MIN_TROPHIES))) { day.battles.skippedLowTrophy++; continue; }
        groups = ['t'];
      } else continue; // friendly, challenge, etc.

      const mine = teams.findIndex((tm) => tm.some((p) => p.tag === tags[i]));
      if (mine < 0) continue;
      const key = `${it.battleTime}|${players.map((p) => p.tag).sort().join(',')}`;
      if (seen.has(key)) continue; // the same game appears in several players' logs
      seen.add(key);

      const mk = `${mode}|${nameKey(ev.map)}`;
      const m = (day.maps[mk] ||= { id: ev.id ?? null, name: ev.map, mode, r: blank(), rL: blank(), rM: blank(), t: blank() });
      if (ev.id && !m.id) m.id = ev.id;
      const mineWon = bt.result === 'victory';
      for (const g of groups) addGame(m[g], teams, mine, mineWon);
      if (groups[0] === 'r') {
        day.battles.ranked++;
        if (groups.includes('rL')) day.battles.legendary++;
        if (groups.includes('rM')) day.battles.masters++;
      } else day.battles.trophy++;
    }
  }
}

// Players to crawl: Legendary+ players met in Ranked games, not already sampled.
export function crawlTags(logs, have, limit) {
  const out = new Set();
  for (const lg of logs) {
    for (const it of listOf(lg)) {
      const bt = it.battle || {};
      if (!RANKED_TYPES.has(bt.type) || !Array.isArray(bt.teams)) continue;
      for (const p of bt.teams.flat()) {
        if (out.size >= limit) return [...out];
        if (p?.tag && !have.has(p.tag) && Number(p.brawler?.trophies) >= LEGENDARY) out.add(p.tag);
      }
    }
  }
  return [...out];
}

// ---------- 2. rank brawlers ----------
const r1 = (x) => Math.round(x * 10) / 10;

// Top players win most of their games, so raw win rates flatter whatever they pick.
// Each brawler is measured against how often its side won on this map instead:
// excess = wins above what that side's average would give.
export function rankBrawlers(a, { pickPrior = false } = {}) {
  const pS = a.sw / a.n; // how often the sampled player's side won here
  let rows = Object.entries(a.b).map(([id, [gS, wS, gO, wO]]) => {
    const g = gS + gO;
    return { id: Number(id), g, excess: wS - gS * pS + (wO - gO * (1 - pS)), ur: (100 * g) / (2 * a.n) };
  }).filter((p) => p.g >= MIN_BRAWLER_GAMES);
  const urs = rows.map((p) => p.ur).sort((x, y) => x - y);
  const median = urs[Math.floor(urs.length / 2)] || 1;
  rows = rows.map((p) => {
    const prior = pickPrior ? 50 + PICK_WEIGHT * Math.max(-1.5, Math.min(1.5, Math.log(p.ur / median))) : 50;
    return {
      ...p,
      // estimated win % vs. an average pick: adjusted for skill, shrunk toward the prior
      wr: (100 * (0.5 * p.g + p.excess) + PRIOR_GAMES * prior) / (p.g + PRIOR_GAMES),
      raw: 100 * (0.5 + p.excess / p.g),
    };
  });
  const row = (p) => [p.id, r1(p.wr), r1(p.ur), r1(p.raw), p.g];
  const byPicks = [...rows].sort((x, y) => y.g - x.g || y.wr - x.wr);
  rows.sort((x, y) => y.wr - x.wr);
  return {
    sample: a.n,
    topSideWin: r1(100 * pS),
    low: a.n < LOW_SAMPLE,
    // [brawlerId, estimated win %, use %, skill-adjusted win % before shrinking, games]
    picks: rows.slice(0, TOP_N).map(row),
    // same rows, most-played first: what good players actually choose on this map
    popular: byPicks.slice(0, TOP_N).map(row),
  };
}

function add(into, from) {
  if (!from) return;
  into.n += from.n;
  into.sw += from.sw;
  for (const [id, v] of Object.entries(from.b)) {
    const s = (into.b[id] ||= [0, 0, 0, 0]);
    for (let k = 0; k < 4; k++) s[k] += v[k];
  }
}
const merged = (...xs) => { const a = blank(); for (const x of xs) add(a, x); return a; };

export function buildMaps(days, rankedPool) {
  const sum = new Map();
  for (const d of days) {
    for (const [k, m] of Object.entries(d.maps)) {
      if (!m.r || m.r.sw === undefined) continue; // file from an older format
      const x = sum.get(k) || { id: m.id, name: m.name, mode: m.mode, r: blank(), rL: blank(), rM: blank(), t: blank() };
      if (m.id && !x.id) x.id = m.id;
      for (const g of GROUPS) add(x[g], m[g]);
      sum.set(k, x);
    }
  }

  const maps = [];
  for (const m of sum.values()) {
    // current
    let basis, a;
    if (m.r.n >= PREFER_RANKED) { basis = 'ranked'; a = m.r; }
    else { basis = m.r.n ? 'mixed' : 'trophy'; a = merged(m.r, m.t); }
    if (a.n < MIN_MAP_BATTLES) continue;
    const cur = rankBrawlers(a);
    if (!cur.picks.length) continue;

    // new (shadow)
    let sBasis, sa;
    if (m.rM.n >= PREFER_MASTERS) { sBasis = 'masters'; sa = m.rM; }
    else if (m.rL.n >= PREFER_LEGENDARY) { sBasis = 'legendary'; sa = m.rL; }
    else { sBasis = basis; sa = a; }
    const shadow = { basis: sBasis, ...rankBrawlers(sa, { pickPrior: true }) };

    maps.push({
      id: m.id ?? `${m.mode}-${nameKey(m.name)}`,
      name: m.name,
      mode: modeName(m.mode),
      modeId: m.mode,
      modeColor: modeColor(m.mode),
      ranked: RANKED_MODES.has(m.mode) && (rankedPool.has(nameKey(m.name)) || m.r.n >= 5),
      basis,
      rankedGames: m.r.n,
      legendaryGames: m.rL.n,
      mastersGames: m.rM.n,
      ...cur,
      shadow,
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
  log(`${Object.keys(brawlers).length} brawlers, reading ${tags.length} top-player battle logs from ${REGIONS.join(',')}`);
  const logs = await pool(tags, 10, (t) => official(`/players/${encodeURIComponent(t)}/battlelog`));
  log(`top-player logs read: ${logs.filter(Boolean).length}/${tags.length}`);

  // Crawl outward, hop by hop, through Legendary+ players met in Ranked games.
  const have = new Set(tags);
  let frontier = logs.slice();
  let crawled = 0;
  for (let hop = 1; crawled < CRAWL_LIMIT && frontier.length; hop++) {
    const extra = crawlTags(frontier, have, CRAWL_LIMIT - crawled);
    if (!extra.length) break;
    for (const t of extra) have.add(t);
    const more = await pool(extra, 10, (t) => official(`/players/${encodeURIComponent(t)}/battlelog`));
    log(`crawl hop ${hop}: read ${more.filter(Boolean).length}/${extra.length} Legendary+ players met in Ranked games`);
    tags.push(...extra);
    logs.push(...more);
    crawled += extra.length;
    frontier = more;
  }

  // Each game goes into the file for the day it was played (UTC).
  // Normal run: only games newer than the last run, merged into existing day files.
  // Backfill (BACKFILL_DAYS=n): every game from the last n days, and those day files are rebuilt.
  await mkdir(DAILY_DIR, { recursive: true });
  const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
  const date = dayOf(started);
  const backfill = BACKFILL_DAYS > 0;
  const since = Date.parse(dayOf(started - (backfill ? BACKFILL_DAYS - 1 : WINDOW_DAYS - 1) * 864e5));
  const touched = new Map();
  // Load (or start) every day file the window can touch, then tally.
  for (let ms = since; ms <= started; ms += 864e5) {
    const d = dayOf(ms);
    const prev = backfill ? null : await readJSON(join(DAILY_DIR, `${d}.json`));
    touched.set(d, prev?.v === DAY_VERSION ? prev : { ...emptyDay(), date: d });
  }
  const cutoff = backfill ? 0 : state.lastRun ? Date.parse(state.lastRun) : 0;
  tallyInto(logs, tags, cutoff, (ms) => (ms >= since ? touched.get(dayOf(ms)) : null));
  touched.get(date).battles.players = (touched.get(date).battles.players || 0) + logs.filter(Boolean).length;
  for (const [d, day] of touched) {
    const file = join(DAILY_DIR, `${d}.json`);
    const hasGames = day.battles.ranked + day.battles.trophy > 0;
    if (hasGames || d === date) await writeFile(file, JSON.stringify(day));
    else if (backfill) await unlink(file).catch(() => {});
    const x = day.battles;
    log(`${d}: ${x.ranked} Ranked (${x.legendary} Legendary+, ${x.masters} Masters+) + ${x.trophy} high-trophy games`);
  }
  await writeFile(STATE, JSON.stringify({ lastRun: new Date(started).toISOString() }, null, 1) + '\n');

  // Window: newest WINDOW_DAYS files; older ones are deleted.
  const files = (await readdir(DAILY_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const keep = files.slice(-WINDOW_DAYS);
  for (const f of files.slice(0, -WINDOW_DAYS)) await unlink(join(DAILY_DIR, f));
  const days = (await Promise.all(keep.map((f) => readJSON(join(DAILY_DIR, f))))).filter(Boolean);
  const maps = buildMaps(days, rankedPool);
  const count = (k) => maps.filter((m) => m.shadow.basis === k).length;
  log(`maps with picks: ${maps.length}; new ranking uses Masters+ on ${count('masters')}, Legendary+ on ${count('legendary')}, all Ranked on ${count('ranked')}`);

  if (maps.length < 5) {
    console.error(`[data] too few maps with picks (${maps.length}), keeping previous data.`);
    process.exit(1);
  }

  // Brawler classes (Damage Dealer, Tank, ...): the official API has none. Saved file, refreshed
  // from Brawlify's API when it answers (it blocks some datacenter IPs, so this is best effort).
  // The saved copy (data/, on the data branch) wins; scripts/brawler-classes.json is the seed.
  const classFile = resolve(ROOT, process.env.CLASS_FILE || 'data/brawler-classes.json');
  const classes = (await readJSON(classFile)) || (await readJSON(resolve(ROOT, 'scripts/brawler-classes.json'))) || { classes: {} };
  if (BRAWLIFY !== 'off') {
    try {
      const j = await getJSON(`${BRAWLIFY}/brawlers`, {}, 1);
      let added = 0;
      for (const b of listOf(j)) {
        const c = b?.class?.name;
        if (b?.id && c && c !== 'Unknown' && classes.classes[b.id] !== c) { classes.classes[b.id] = c; added++; }
      }
      if (added) {
        await mkdir(dirname(classFile), { recursive: true });
        await writeFile(classFile, JSON.stringify(classes, null, 1) + '\n');
      }
      log(`brawler classes: ${added} updated from Brawlify`);
    } catch (e) {
      log('brawler classes: Brawlify unavailable, using saved file');
    }
  }

  const used = new Set(maps.flatMap((m) => [...m.picks, ...m.popular, ...m.shadow.picks, ...m.shadow.popular].map((p) => p[0])));
  const B = {};
  await pool([...used], 8, async (id) => {
    if (!brawlers[id]) return;
    B[id] = { ...brawlers[id], c: classes.classes[id] || '', img: await ensureImage('brawlers', id) };
  });
  await pool(maps, 8, async (m) => { m.img = typeof m.id === 'number' ? await ensureImage('maps', m.id) : null; });
  for (const m of maps) {
    for (const r of [m, m.shadow]) {
      r.picks = r.picks.filter((p) => B[p[0]]);
      r.popular = r.popular.filter((p) => B[p[0]]);
    }
  }

  // Brawlers seen in plenty of trophy games but never in Ranked (e.g. just released, not yet
  // allowed in Ranked). The site labels them so trophy picks aren't mistaken for Ranked advice.
  const seenIn = { r: {}, t: {} };
  for (const d of days) for (const m of Object.values(d.maps)) for (const g of ['r', 't']) {
    for (const [id, v] of Object.entries(m[g]?.b || {})) seenIn[g][id] = (seenIn[g][id] || 0) + v[0] + v[2];
  }
  const notInRanked = Object.keys(seenIn.t).filter((id) => seenIn.t[id] >= 30 && !seenIn.r[id]).map(Number);

  const totals = { ranked: 0, legendary: 0, masters: 0, trophy: 0 };
  for (const d of days.filter((x) => x.v === DAY_VERSION)) for (const k of Object.keys(totals)) totals[k] += d.battles[k] || 0;
  const data = {
    generatedAt: new Date().toISOString(),
    window: { days: days.length, from: keep[0]?.slice(0, 10), to: date },
    minTrophies: MIN_TROPHIES,
    battles: totals,
    notInRanked,
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
