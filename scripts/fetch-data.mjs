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
// Per map, brawlers get (see "2. rank brawlers"):
//   win    skill-adjusted win rate, shrunk toward 50% by a strength fitted from the data
//   score  the same, shrunk toward a starting point set by presence (pick + ban rate) instead
//   pick %, ban %, games
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
const MIN_MAP_BATTLES = 15; // fewer than this: map gets no picks
const PREFER_RANKED = 40; // ranked-only stats once a map has this many ranked games
const PREFER_LEGENDARY = 40; // new ranking: Legendary+ only from this many games
const PREFER_MASTERS = 150; // new ranking: Masters+ only from this many games
const LOW_SAMPLE = 150; // below this the site labels the picks "few games"
const MIN_BRAWLER_GAMES = 10;
const MAX_ROWS = 40; // brawlers kept per map
const DAY_VERSION = 3;

const readJSON = (p) => readFile(p, 'utf8').then(JSON.parse, () => null);
const RANKED_TYPES = new Set(['soloRanked', 'teamRanked']);
// Per map and group: n games, sw = games won by the sampled player's side,
// b[brawlerId] = [games, wins] on the sampled side, then [games, wins] on the other side,
// bans[brawlerId] = Ranked games in which it was banned (each player bans one brawler).
// Groups: r = all Ranked, rL = Ranked with every player Legendary+, rM = Masters+, t = high-trophy.
const GROUPS = ['r', 'rL', 'rM', 't'];
const blank = () => ({ n: 0, sw: 0, b: {}, bans: {} });
const emptyDay = () => ({ v: DAY_VERSION, battles: { ranked: 0, legendary: 0, masters: 0, trophy: 0, skippedLowTrophy: 0, players: 0 }, maps: {} });

function addGame(a, teams, mine, mineWon) {
  a.n++;
  const banned = new Set(teams.flat().map((p) => p.bannedBrawler?.id).filter(Boolean));
  for (const id of banned) a.bans[id] = (a.bans[id] || 0) + 1;
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

// Per brawler on one map: games, skill-adjusted excess wins, pick share and ban share.
// Top players win most of their games, so raw win rates flatter whatever they pick. Each brawler is
// measured against how often its side won on this map instead: excess = wins above that side's average.
export function brawlerRows(a) {
  const pS = a.sw / a.n;
  return Object.entries(a.b).map(([id, [gS, wS, gO, wO]]) => {
    const g = gS + gO;
    return {
      id: Number(id), g,
      excess: wS - gS * pS + (wO - gO * (1 - pS)),
      pick: g / (2 * a.n), // share of teams that played it
      ban: (a.bans?.[id] || 0) / a.n, // share of games where it was banned
    };
  });
}

// "Presence": how often good players pick or ban it here. In draft, a banned brawler can't be
// picked, so strong brawlers show up in bans as much as in picks.
const presence = (r) => Math.log(Math.max(r.pick + r.ban, 1e-4));

// Empirical Bayes, fitted on every run from all maps together:
//   true win rate on a map ~ 50% + slope * (presence vs. the map's median), with spread tau.
// From that: K = how many games of evidence the starting point is worth (0.25 / tau^2).
// If presence doesn't predict winning, slope comes out ~0 and this is plain shrinking toward 50%.
export function fitModel(maps, feature = presence) {
  const pts = [];
  for (const rows of maps) {
    const ok = rows.filter((r) => r.g >= MIN_BRAWLER_GAMES);
    const med = median(ok.map(feature));
    for (const r of ok) pts.push({ x: feature(r) - med, y: r.excess / r.g, w: r.g });
  }
  if (pts.length < 30) return { K: 150, slope: 0, n: pts.length };
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) { sw += p.w; sx += p.w * p.x; sy += p.w * p.y; sxx += p.w * p.x * p.x; sxy += p.w * p.x * p.y; }
  const vx = sxx - (sx * sx) / sw;
  const slope = vx > 1e-9 ? (sxy - (sx * sy) / sw) / vx : 0;
  let num = 0;
  for (const p of pts) { const res = p.y - slope * p.x; num += p.w * (res * res) - 0.25; }
  const tau2 = Math.max(num / sw, 0.25 / 600);
  return { K: Math.round(Math.min(600, Math.max(40, 0.25 / tau2))), slope: Math.min(0.04, Math.max(0, slope)), n: pts.length };
}
function median(xs) { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; }

// Score each brawler on one map.
//   win   = skill-adjusted win rate, pulled toward 50% (fitted strength, no presence)
//   score = the same, but pulled toward a starting point set by presence (fitted slope)
export function scoreRows(rows, scoreModel, winModel) {
  const ok = rows.filter((r) => r.g >= MIN_BRAWLER_GAMES);
  const med = median(ok.map(presence));
  return ok.map((r) => {
    const prior = 0.5 + scoreModel.slope * Math.max(-2, Math.min(2, presence(r) - med));
    return {
      ...r,
      score: (0.5 * r.g + r.excess + scoreModel.K * prior) / (r.g + scoreModel.K),
      win: (0.5 * r.g + r.excess + winModel.K * 0.5) / (r.g + winModel.K),
    };
  }).sort((x, y) => y.score - x.score);
}

function add(into, from) {
  if (!from) return;
  into.n += from.n;
  into.sw += from.sw;
  for (const [id, v] of Object.entries(from.b)) {
    const s = (into.b[id] ||= [0, 0, 0, 0]);
    for (let k = 0; k < 4; k++) s[k] += v[k];
  }
  for (const [id, c] of Object.entries(from.bans || {})) into.bans[id] = (into.bans[id] || 0) + c;
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

  // Pick the games each map is ranked from: Masters+ when there are enough, else Legendary+,
  // else all Ranked, else Ranked + high-trophy games together (specialty maps: trophy games).
  const chosen = [];
  for (const m of sum.values()) {
    let basis, a;
    if (m.rM.n >= PREFER_MASTERS) { basis = 'masters'; a = m.rM; }
    else if (m.rL.n >= PREFER_LEGENDARY) { basis = 'legendary'; a = m.rL; }
    else if (m.r.n >= PREFER_RANKED) { basis = 'ranked'; a = m.r; }
    else { basis = m.r.n ? 'mixed' : 'trophy'; a = merged(m.r, m.t); }
    if (a.n < MIN_MAP_BATTLES) continue;
    chosen.push({ m, basis, a, rows: brawlerRows(a) });
  }

  // Fit the model separately for Ranked-based maps (picks + bans) and trophy-based maps (no bans).
  const family = (c) => (['masters', 'legendary', 'ranked'].includes(c.basis) ? 'ranked' : 'trophy');
  const model = {};
  for (const f of ['ranked', 'trophy']) {
    const rowsByMap = chosen.filter((c) => family(c) === f).map((c) => c.rows);
    model[f] = { score: fitModel(rowsByMap), win: fitModel(rowsByMap, () => 0) };
  }

  const maps = [];
  for (const { m, basis, a, rows } of chosen) {
    const md = model[family({ basis })];
    const scored = scoreRows(rows, md.score, md.win);
    if (!scored.length) continue;
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
      legendaryGames: m.rL.n,
      mastersGames: m.rM.n,
      topSideWin: r1(100 * (a.sw / a.n)),
      low: a.n < LOW_SAMPLE,
      // [brawlerId, score %, win %, pick %, games, ban %], best score first
      rows: scored.slice(0, MAX_ROWS).map((r) => [r.id, r1(100 * r.score), r1(100 * r.win), r1(100 * r.pick), r.g, r1(100 * r.ban)]),
    });
  }
  maps.sort((x, y) => x.name.localeCompare(y.name));
  return { maps, model };
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
  const { maps, model } = buildMaps(days, rankedPool);
  const count = (k) => maps.filter((m) => m.basis === k).length;
  log(`maps with picks: ${maps.length}; Masters+ ${count('masters')}, Legendary+ ${count('legendary')}, all Ranked ${count('ranked')}, other ${count('mixed') + count('trophy')}`);
  for (const [f, md] of Object.entries(model)) log(`model ${f}: score prior worth ${md.score.K} games, presence slope ${(100 * md.score.slope).toFixed(2)} pts/e-fold; win prior worth ${md.win.K} games (${md.score.n} brawler-map rows)`);

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

  const used = new Set(maps.flatMap((m) => m.rows.map((p) => p[0])));
  const B = {};
  await pool([...used], 8, async (id) => {
    if (!brawlers[id]) return;
    B[id] = { ...brawlers[id], c: classes.classes[id] || '', img: await ensureImage('brawlers', id) };
  });
  await pool(maps, 8, async (m) => { m.img = typeof m.id === 'number' ? await ensureImage('maps', m.id) : null; });
  for (const m of maps) {
    m.rows = m.rows.filter((p) => B[p[0]]);
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
    model,
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
