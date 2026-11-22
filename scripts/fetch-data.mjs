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
//   PROFILE_LIMIT    Legendary+ player profiles to read per run for builds (default 1500, 0 = off)
//   MIN_TROPHIES     min brawler trophies for every player in a trophy game (default 750)
//   WINDOW_DAYS      days of daily files to combine (default 14)
//   BRAWLIFY_BASE    Brawlify API for brawler classes (default https://api.brawlapi.com/v1, "off" to skip)
//   IMAGES           "off" to skip downloading images
//   OUT, DAILY_DIR   output paths (for tests)

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import {
  ROOT, BS_KEY, log, official, getJSON, pool, listOf, parseTime, titleCase, nameKey,
  modeName, modeColor, RANKED_MODES, ensureImage, getText
} from './lib.mjs';
import { blankBuilds, tallyBuilds, summarizeBuilds, buffyBrawlers, blankEffects, tallyEffects, addEffects, solveEffects } from './builds.mjs';
import { fetchPages, recentChanges, fetchOfficial, mergeChanges, resetsFrom } from './balance.mjs';

const PLAYER_LIMIT = Number(process.env.BS_PLAYER_LIMIT || 200);
const REGIONS = (process.env.BS_REGIONS || 'global,us,kr,br,de,jp,mx,fr').split(',').map((s) => s.trim()).filter(Boolean);
const CRAWL_LIMIT = Number(process.env.CRAWL_LIMIT ?? 3000);
const BRAWLIFY = process.env.BRAWLIFY_BASE || 'https://api.brawlapi.com/v1';
const PROFILE_LIMIT = Number(process.env.PROFILE_LIMIT ?? 1500);
const MIN_TROPHIES = Number(process.env.MIN_TROPHIES || 750);
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 14);
const BACKFILL_DAYS = Math.min(Number(process.env.BACKFILL_DAYS || 0), WINDOW_DAYS);
const OUT = resolve(ROOT, process.env.OUT || 'site/data/data.json');
const DAILY_DIR = resolve(ROOT, process.env.DAILY_DIR || 'data/daily');
const STATE = join(DAILY_DIR, '..', 'state.json');
const BUILD_DIR = join(DAILY_DIR, '..', 'builds');

export const LEGENDARY = 16;
export const MASTERS = 19;
const MIN_MAP_BATTLES = 15; // fewer than this: map gets no picks
const PREFER_RANKED = 40; // ranked-only stats once a map has this many ranked games
const PREFER_LEGENDARY = 40; // new ranking: Legendary+ only from this many games
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
const blank = () => ({ n: 0, sw: 0, b: {}, bans: {} }); // + c (trios) for rL and t
const emptyDay = () => ({ v: DAY_VERSION, battles: { ranked: 0, legendary: 0, masters: 0, trophy: 0, skippedLowTrophy: 0, players: 0 }, maps: {} });

// Trios (3-player teams) are stored as "a.b.c" brawler-id offsets from ID_BASE, sorted, with
// [games, wins] on the sampled side then the other side. Pairs are derived from trios.
const ID_BASE = 16000000;
function addGame(a, teams, mine, mineWon, combos = false) {
  a.n++;
  if (combos) {
    teams.forEach((team, ti) => {
      if (team.length !== 3) return;
      const key = team.map((p) => p.brawler.id - ID_BASE).sort((x, y) => x - y).join('.');
      const side = ti === mine ? 0 : 2;
      const s = ((a.c ||= {})[key] ||= [0, 0, 0, 0]);
      s[side]++;
      if ((ti === mine) === mineWon) s[side + 1]++;
    });
  }
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
      // combos only for Legendary+ Ranked and high-trophy games (keeps the data small)
      for (const g of groups) addGame(m[g], teams, mine, mineWon, g === 'rL' || g === 't');
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

// Empirical Bayes, two levels, fitted on every run from all maps of a family together:
//   true win rate of brawler b on map m = 50% + intercept + slope * x + u_b + e_bm
//   x   = presence (pick + ban share) vs. the map's median, capped at +/-2 (same cap fit and score)
//   u_b = the brawler's own strength across all maps (spread tauB), e_bm = this map (spread tau)
// The starting point (prior) for a brawler on a map is 50% + intercept + slope * x + its shrunk u_b;
// K = 0.25 / tau^2 is how many games of evidence that starting point is worth.
// The intercept matters: most games are on popular brawlers (x > 0), and the game-weighted
// average brawler is exactly 50%, so the line has to cross 50% above x = 0.
// Variances are fitted by maximum likelihood (normal approximation, coin-flip noise 0.25/g).
export const PRESENCE_CAP = 2;
const capX = (x) => Math.max(-PRESENCE_CAP, Math.min(PRESENCE_CAP, x));
// ML estimate of the true spread t of values y_i measured with noise variance v_i (mean 0)
function mlVar(pts, start) {
  let t = start;
  for (let it = 0; it < 100; it++) {
    let s1 = 0, s2 = 0;
    for (const p of pts) { const V = t + p.v; s1 += (p.y * p.y) / (V * V) - 1 / V; s2 += 1 / (V * V); }
    const next = Math.max(1e-7, t + s1 / s2);
    if (Math.abs(next - t) < 1e-9) return next;
    t = next;
  }
  return t;
}
// each brawler's precision-weighted average residual across maps, shrunk toward 0
function brawlerEffects(pts, tau2) {
  const by = new Map();
  for (const p of pts) { const v = 0.25 / p.w + tau2, e = by.get(p.id) || { s: 0, w: 0 }; e.s += p.res / v; e.w += 1 / v; by.set(p.id, e); }
  const es = [...by].map(([id, e]) => ({ id, y: e.s / e.w, v: 1 / e.w }));
  const tB = mlVar(es, 1e-4);
  return { tauB2: tB, eff: new Map(es.map((e) => [e.id, (e.y * tB) / (tB + e.v)])) };
}
export function fitModel(maps, feature = presence, { hierarchy = true } = {}) {
  const pts = [];
  for (const rows of maps) {
    const ok = rows.filter((r) => r.g >= MIN_BRAWLER_GAMES);
    const med = median(ok.map(feature));
    for (const r of ok) pts.push({ id: r.id, x: capX(feature(r) - med), y: r.excess / r.g, w: r.g });
  }
  if (pts.length < 30) return { K: 150, slope: 0, intercept: 0, n: pts.length, brawler: {} };
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) { sw += p.w; sx += p.w * p.x; sy += p.w * p.y; sxx += p.w * p.x * p.x; sxy += p.w * p.x * p.y; }
  const vx = sxx - (sx * sx) / sw;
  const slope = Math.min(0.04, Math.max(0, vx > 1e-9 ? (sxy - (sx * sy) / sw) / vx : 0));
  const intercept = sy / sw - slope * (sx / sw); // weighted line through the data's centre
  for (const p of pts) p.res = p.y - intercept - slope * p.x;
  const mapLevel = (shift) => mlVar(pts.map((p) => ({ y: p.res - (shift?.get(p.id) || 0), v: 0.25 / p.w })), 0.25 / 150);
  let tau2 = mapLevel(), brawler = new Map(), tauB2 = 0;
  if (hierarchy) {
    // alternate: brawler effects given tau, then tau given the effects (converges in a few rounds)
    for (let i = 0; i < 3; i++) { ({ eff: brawler, tauB2 } = brawlerEffects(pts, tau2)); tau2 = mapLevel(brawler); }
  }
  const K = Math.round(Math.min(600, Math.max(40, 0.25 / Math.max(tau2, 0.25 / 600))));
  return {
    K, slope, intercept, n: pts.length,
    ...(hierarchy ? { brawlerSpread: Math.sqrt(tauB2), brawler: Object.fromEntries([...brawler].map(([id, e]) => [id, Math.round(e * 1e5) / 1e5])) } : {}),
  };
}
function median(xs) { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; }

// Score each brawler on one map.
//   win   = skill-adjusted win rate, pulled toward 50% (fitted strength, no presence)
//   score = the same, but pulled toward a starting point set by presence (fitted slope)
export function scoreRows(rows, scoreModel, winModel) {
  const ok = rows.filter((r) => r.g >= MIN_BRAWLER_GAMES);
  const med = median(ok.map(presence));
  return ok.map((r) => {
    const prior = 0.5 + (scoreModel.intercept || 0) + scoreModel.slope * capX(presence(r) - med) + (scoreModel.brawler?.[r.id] || 0);
    return {
      ...r,
      score: (0.5 * r.g + r.excess + scoreModel.K * prior) / (r.g + scoreModel.K),
      win: (0.5 * r.g + r.excess + winModel.K * 0.5) / (r.g + winModel.K),
    };
  }).sort((x, y) => y.score - x.score);
}

// Balance changes: a brawler changed in the window only counts games after the change (the patch
// day is mixed, so it's dropped too). With fewer than MIN_DAYS_AFTER days of fresh games it's left
// out of the rankings entirely: steady data over a guess. Day files on disk stay untouched.
export const MIN_DAYS_AFTER = 3;
export function applyResets(days, resets, minDays = MIN_DAYS_AFTER) {
  const hidden = new Set();
  const cut = new Map(Object.entries(resets).map(([id, d]) => [Number(id), d]));
  for (const [id, d] of cut) if (days.filter((x) => x.date > d).length < minDays) hidden.add(id);
  if (!cut.size) return { days, hidden, stats: {} };
  const strip = (g, ids) => {
    if (!g) return g;
    const b = { ...g.b }, bans = { ...(g.bans || {}) };
    for (const id of ids) { delete b[id]; delete bans[id]; }
    let c = g.c;
    if (c) c = Object.fromEntries(Object.entries(c).filter(([k]) => !k.split('.').some((o) => ids.has(Number(o) + 16000000))));
    return { ...g, b, bans, ...(c ? { c } : {}) };
  };
  // per brawler: games dropped vs kept, so each live run shows what the reset did
  const stats = Object.fromEntries([...cut.keys()].map((id) => [id, { dropped: 0, kept: 0 }]));
  for (const day of days) for (const m of Object.values(day.maps || {})) for (const gk of GROUPS) {
    for (const id of cut.keys()) {
      const v = m[gk]?.b?.[id];
      if (!v) continue;
      const n = v[0] + v[2];
      if (hidden.has(id) || day.date <= cut.get(id)) stats[id].dropped += n; else stats[id].kept += n;
    }
  }
  const out = days.map((day) => {
    const ids = new Set([...cut].filter(([id, d]) => hidden.has(id) || day.date <= d).map(([id]) => id));
    if (!ids.size) return day;
    return { ...day, maps: Object.fromEntries(Object.entries(day.maps || {}).map(([k, m]) => [k, Object.fromEntries(Object.entries(m).map(([gk, g]) => [gk, GROUPS.includes(gk) ? strip(g, ids) : g]))])) };
  });
  return { days: out, hidden, stats };
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
  for (const [k, v] of Object.entries(from.c || {})) {
    const s = ((into.c ||= {})[k] ||= [0, 0, 0, 0]);
    for (let i = 0; i < 4; i++) s[i] += v[i];
  }
}

// Best duos and trios on one map, from a group with trios (g.c).
//   win     = the combo's skill-adjusted win rate, pulled toward 50% like single brawlers (K games)
//   synergy = how much better (points) the combo did than its brawlers' own results add up to
const MIN_DUO = 40, MIN_TRIO = 30, TOP_COMBOS = 5;
export function combosFor(g, K) {
  if (!g?.c || !g.n) return null;
  const pS = g.sw / g.n;
  const solo = {};
  for (const [id, [gS, wS, gO, wO]] of Object.entries(g.b)) {
    const n = gS + gO;
    if (n) solo[id] = (wS - gS * pS + (wO - gO * (1 - pS))) / n;
  }
  const pairs = {};
  const rows = (dict, min) => Object.entries(dict).map(([key, [gS, wS, gO, wO]]) => {
    const n = gS + gO;
    const ids = key.split('.').map((x) => ID_BASE + Number(x));
    const ex = wS - gS * pS + (wO - gO * (1 - pS));
    const expected = ids.reduce((s, id) => s + (solo[id] || 0), 0);
    // synergy is pulled toward 0 like win rates, so a few lucky games can't show a huge "together" bonus
    return { ids, n, win: (0.5 * n + ex + K * 0.5) / (n + K), synergy: (ex - expected * n) / (n + K) };
  }).filter((r) => r.n >= min).sort((x, y) => y.win - x.win).slice(0, TOP_COMBOS)
    .map((r) => [r.ids, r1(100 * r.win), r.n, r1(100 * r.synergy)]);
  for (const [key, v] of Object.entries(g.c)) {
    const [a, b, c] = key.split('.');
    for (const pk of [`${a}.${b}`, `${a}.${c}`, `${b}.${c}`]) {
      const s = (pairs[pk] ||= [0, 0, 0, 0]);
      for (let i = 0; i < 4; i++) s[i] += v[i];
    }
  }
  const duos = rows(pairs, MIN_DUO), trios = rows(g.c, MIN_TRIO);
  return duos.length || trios.length ? { duos, trios } : null;
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

  // Pick the games each map is ranked from: Legendary+ when there are enough,
  // else all Ranked, else Ranked + high-trophy games together (specialty maps: trophy games).
  const chosen = [];
  for (const m of sum.values()) {
    let basis, a;
    // Legendary+ for every map that has enough of those games; Masters+ alone is still too few
    // games for steady numbers (it's still counted, as mastersGames, for reference).
    if (m.rL.n >= PREFER_LEGENDARY) { basis = 'legendary'; a = m.rL; }
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
    model[f] = { score: fitModel(rowsByMap), win: fitModel(rowsByMap, () => 0, { hierarchy: false }) };
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
      // [[brawlerIds], win %, games, synergy points], best win first
      combos: combosFor(family({ basis }) === 'ranked' ? m.rL : m.t, md.win.K),
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
  const itemNames = {};
  for (const b of listOf(brawlersJ)) {
    if (b?.id && b?.name) brawlers[b.id] = { n: titleCase(b.name) };
    for (const it of [...(b.starPowers || []), ...(b.gadgets || [])]) if (it?.id && it.name) itemNames[it.id] = titleCase(it.name);
  }
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

  // Builds: read Legendary+ players' profiles (each player at most once per window).
  await mkdir(BUILD_DIR, { recursive: true });
  const runDate = new Date(started).toISOString().slice(0, 10);
  const seenFile = join(BUILD_DIR, 'seen.json');
  const seen = (await readJSON(seenFile)) || {};
  const oldest = new Date(started - (WINDOW_DAYS - 1) * 864e5).toISOString().slice(0, 10);
  for (const [t, d] of Object.entries(seen)) if (d < oldest) delete seen[t];
  const buildFiles = async () => (await readdir(BUILD_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-WINDOW_DAYS);
  if (PROFILE_LIMIT > 0) {
    // Players whose battle logs we just read come first: their profile + games feed the
    // "what missing pieces cost" estimate. Then other Legendary+ players met in Ranked games.
    const cands = new Set();
    tags.forEach((t, i) => { if (logs[i] && !seen[t]) cands.add(t); });
    for (const lg of logs) for (const it of listOf(lg)) {
      const bt = it.battle || {};
      if (!RANKED_TYPES.has(bt.type) || !Array.isArray(bt.teams)) continue;
      for (const p of bt.teams.flat()) if (p?.tag && !seen[p.tag] && Number(p.brawler?.trophies) >= LEGENDARY) cands.add(p.tag);
    }
    const pick = [...cands].slice(0, PROFILE_LIMIT);
    const profiles = await pool(pick, 10, (t) => official(`/players/${encodeURIComponent(t)}`));
    const bfile = join(BUILD_DIR, `${runDate}.json`);
    const files = await buildFiles();
    const days = await Promise.all(files.map((f) => readJSON(join(BUILD_DIR, f))));
    const priorDays = days.filter(Boolean);
    const prior = summarizeBuilds(priorDays);
    const counts = tallyBuilds(profiles, (await readJSON(bfile)) || blankBuilds(), itemNames);
    const logsByTag = new Map(tags.map((t, i) => [t, logs[i]]));
    // earlier days + today (today's file is in priorDays too, so leave that copy out)
    const otherDays = days.filter((d, i) => d && files[i] !== `${runDate}.json`);
    const buffy = new Set(buffyBrawlers([...otherDays, counts]));
    // v3: only brawlers that really have buffies can miss them (v2 counted every brawler)
    counts.eff = tallyEffects(profiles, logsByTag, prior, counts.eff?.v === 3 ? counts.eff : blankEffects(), buffy);
    pick.forEach((t, i) => { if (profiles[i]) seen[t] = runDate; });
    await writeFile(bfile, JSON.stringify(counts));
    await writeFile(seenFile, JSON.stringify(seen));
    log(`builds: read ${profiles.filter(Boolean).length}/${pick.length} new Legendary+ profiles (${counts.players} today, ${Object.keys(seen).length} in window); build-cost games today: ${counts.eff.n}`);
  }
  const itemsFile = join(BUILD_DIR, 'items.json');
  Object.assign(itemNames, { ...((await readJSON(itemsFile)) || {}), ...itemNames });
  await writeFile(itemsFile, JSON.stringify(itemNames));
  const bfiles = (await readdir(BUILD_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const f of bfiles.slice(0, -WINDOW_DAYS)) await unlink(join(BUILD_DIR, f));
  const buildDays = (await Promise.all(bfiles.slice(-WINDOW_DAYS).map((f) => readJSON(join(BUILD_DIR, f))))).filter(Boolean);
  const builds = summarizeBuilds(buildDays);
  const buffies = buffyBrawlers(buildDays);
  log(`buffies: ${buffies.length} brawlers have them`);
  const costs = solveEffects(buildDays.reduce((acc, d) => addEffects(acc, d.eff), blankEffects()));
  log(`build costs from ${costs.n} games / ${costs.players} players: ` + Object.entries(costs.pieces).map(([k, v]) => `${k} ${v.effect}±${v.se} -> ${v.penalty}`).join(', '));

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
  const rawDays = (await Promise.all(keep.map((f) => readJSON(join(DAILY_DIR, f))))).filter(Boolean);
  rawDays.forEach((d, i) => { d.date ||= keep[i].slice(0, 10); });

  // Recent balance changes: official release notes first, Liquipedia for anything they miss.
  // Fetched at most once a day (data/balance.json); a failed fetch keeps the saved copy.
  const balFile = resolve(ROOT, 'data/balance.json');
  let bal = (await readJSON(balFile)) || { fetchedAt: null, official: [], liquipedia: [] };
  if (process.env.BALANCE !== 'off' && !(Date.now() - Date.parse(bal.fetchedAt || 0) < 20 * 3600e3)) {
    const names = Object.fromEntries(Object.entries(brawlers).map(([id, b]) => [id, b.n]));
    const next = { ...bal, fetchedAt: new Date().toISOString() };
    try { next.official = await fetchOfficial((u) => getText(u), names); } catch (e) { log('balance: official notes unavailable:', e.message); }
    try { next.liquipedia = recentChanges(await fetchPages(names, (u, h) => getJSON(u, h)), date, 45); } catch (e) { log('balance: Liquipedia unavailable:', e.message); }
    bal = next;
    await mkdir(dirname(balFile), { recursive: true });
    await writeFile(balFile, JSON.stringify(bal));
  }
  const winStart = new Date(Date.parse(date) - (WINDOW_DAYS - 1) * 864e5).toISOString().slice(0, 10);
  const updates = mergeChanges(bal.official || [], bal.liquipedia || []).filter((c) => c.date >= winStart && c.date <= date && brawlers[c.id]);
  const resets = resetsFrom(updates);
  const { days, hidden, stats: resetStats } = applyResets(rawDays, resets);
  log(`balance: ${updates.length} changes in the window; reset ${Object.keys(resets).length} brawlers, ${hidden.size} hidden until they have ${MIN_DAYS_AFTER} days of fresh games`);
  for (const [id, st] of Object.entries(resetStats)) if (st.dropped || hidden.has(Number(id))) log(`  reset ${brawlers[id]?.n} (changed ${resets[id]}): dropped ${st.dropped} games, kept ${st.kept}${hidden.has(Number(id)) ? ', hidden' : ''}`);

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
  const seed = (await readJSON(resolve(ROOT, 'scripts/brawler-classes.json'))) || { classes: {} };
  const classes = (await readJSON(classFile)) || { classes: {} };
  // the seed fills gaps (new brawlers): Brawlify blocks the runners, so the saved copy never learns them
  for (const [id, c] of Object.entries(seed.classes)) if (!classes.classes[id]) classes.classes[id] = c;
  // new brawlers can be seeded by name before their id is known
  const byName = new Map(Object.entries(seed.byName || {}).map(([n, c]) => [nameKey(n), c]));
  for (const [id, b] of Object.entries(brawlers)) if (!classes.classes[id] && byName.has(nameKey(b.n))) classes.classes[id] = byName.get(nameKey(b.n));
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

  const noClass = Object.keys(brawlers).filter((id) => !classes.classes[id]).map((id) => brawlers[id].n);
  if (noClass.length) log(`warn: no class for ${noClass.join(', ')}; add them to scripts/brawler-classes.json`);

  const inMaps = maps.flatMap((m) => [...m.rows.map((p) => p[0]), ...['duos', 'trios'].flatMap((k) => (m.combos?.[k] || []).flatMap((c) => c[0]))]);
  const used = new Set([...updates.map((c) => c.id), ...inMaps]); // changed brawlers need names/images for the Updates page
  const B = {};
  await pool([...used], 8, async (id) => {
    if (!brawlers[id]) return;
    B[id] = { ...brawlers[id], c: classes.classes[id] || '', img: await ensureImage('brawlers', id) };
    if (builds[id]) B[id].b = builds[id];
  });
  // Names and icons for the build items shown.
  const items = {};
  const want = [];
  for (const b of Object.values(B)) {
    if (b.b?.sp) want.push(['star-powers-framed', b.b.sp[0]]);
    if (b.b?.gad) want.push(['gadgets-framed', b.b.gad[0]]);
    for (const g of b.b?.gear?.[0] || []) want.push(['gears', g]);
  }
  await pool(want, 8, async ([kind, id]) => { items[id] = { n: itemNames[id] || '', img: await ensureImage(kind, id) }; });
  await pool(maps, 8, async (m) => { m.img = typeof m.id === 'number' ? await ensureImage('maps', m.id) : null; });
  for (const m of maps) {
    m.rows = m.rows.filter((p) => B[p[0]]);
    if (m.combos) for (const k of ['duos', 'trios']) m.combos[k] = m.combos[k].filter((c) => c[0].every((id) => B[id]));
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
    costs,
    notInRanked,
    buffies, // brawler ids that have buffies in the game
    // last 14 days of balance changes (newest first) and which brawlers' games restart after one
    updates: updates.map(({ id, date, kind, buffs, nerfs, reworks, reason, lines, source, url }) => ({ id, date, kind, buffs, nerfs, reworks, reason: reason || '', lines: lines.slice(0, 12), source, url })),
    resets: Object.fromEntries(Object.entries(resets).map(([id, d]) => [id, { after: d, hidden: hidden.has(Number(id)), freshDays: days.filter((x) => x.date > d).length }])),
    items,
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
