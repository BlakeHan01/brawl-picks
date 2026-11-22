#!/usr/bin/env node
// Score lab: does the production ranking predict how brawlers do on days it hasn't seen?
// Forward in time only: for each day D, fit on the days before D, test on D. Uses the production
// functions (brawlerRows, fitModel, scoreRows), so the numbers are for what the site runs.
//   node scripts/score-lab.mjs [group=rL]      (DAILY_DIR = folder of day files, default data/daily)
// Metrics per day, then the game-weighted mean and the paired difference vs the site (+/- SE):
//   miss  = typical distance between the estimate and the brawler's true win rate on the test day,
//           in points, after removing the coin-flip noise every method shares (lower is better):
//           E[g(y-p)^2] = g(mu-p)^2 + mu(1-mu), so subtract y(1-y)g/(g-1) per brawler.
//   top 5 = skill-adjusted win rate on the test day of each map's top 5 (higher is better).
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ROOT } from './lib.mjs';
import { brawlerRows, fitModel, scoreRows } from './fetch-data.mjs';

const GROUP = process.argv[2] || 'rL';
const DIR = resolve(ROOT, process.env.DAILY_DIR || 'data/daily');
const MIN_TRAIN_DAYS = 3, FIT_MIN = 40, TEST_MIN = 100;
const files = (await readdir(DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const days = await Promise.all(files.map(async (f) => ({ date: f.slice(0, 10), d: JSON.parse(await readFile(join(DIR, f), 'utf8')) })));

function sum(list) {
  const maps = new Map();
  for (const { d } of list) for (const [k, m] of Object.entries(d.maps)) {
    const a = m[GROUP]; if (!a?.n) continue;
    const x = maps.get(k) || { n: 0, sw: 0, b: {}, bans: {}, c: {} };
    x.n += a.n; x.sw += a.sw;
    for (const [t, v] of Object.entries(a.c || {})) { const s = (x.c[t] ||= [0, 0, 0, 0]); for (let i = 0; i < 4; i++) s[i] += v[i]; }
    for (const [id, v] of Object.entries(a.b)) { const s = (x.b[id] ||= [0, 0, 0, 0]); for (let i = 0; i < 4; i++) s[i] += v[i]; }
    for (const [id, c] of Object.entries(a.bans || {})) x.bans[id] = (x.bans[id] || 0) + c;
    maps.set(k, x);
  }
  return maps;
}
const presence = (r) => Math.log(Math.max(r.pick + r.ban, 1e-4));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };
// The site before the review fix: intercept dropped, cap only when scoring
function oldScores(rows, K, slope) {
  const ok = rows.filter((r) => r.g >= 10), med = median(ok.map(presence));
  return new Map(ok.map((r) => [r.id, (0.5 * r.g + r.excess + K * (0.5 + slope * Math.max(-2, Math.min(2, presence(r) - med)))) / (r.g + K)]));
}
function oldFit(maps) { // previous fitModel, verbatim in effect
  const pts = [];
  for (const rows of maps) { const ok = rows.filter((r) => r.g >= 10); const med = median(ok.map(presence)); for (const r of ok) pts.push({ x: presence(r) - med, y: r.excess / r.g, w: r.g }); }
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) { sw += p.w; sx += p.w * p.x; sy += p.w * p.y; sxx += p.w * p.x * p.x; sxy += p.w * p.x * p.y; }
  const slope = (sxy - (sx * sy) / sw) / (sxx - (sx * sx) / sw);
  let num = 0; for (const p of pts) { const res = p.y - slope * p.x; num += p.w * res * res - 0.25; }
  return { K: Math.round(Math.min(600, Math.max(40, 0.25 / Math.max(num / sw, 0.25 / 600)))), slope: Math.min(0.04, Math.max(0, slope)) };
}

// Teammate-adjusted (RAPM, as in basketball/soccer plus-minus): each 3-brawler team's skill-adjusted
// result (wins minus its side's usual rate) is split across its members by ridge regression:
//   minimise sum_teams games * (excess rate - b_a - b_b - b_c)^2 + lambda * sum b^2
// b_i is then the brawler's own win-rate effect with teammates held constant.
function rapm(a, lambda) {
  const pS = a.sw / a.n;
  const ids = new Map();
  const rowsT = [];
  for (const [key, [gS, wS, gO, wO]] of Object.entries(a.c || {})) {
    const mem = key.split('.').map((o) => String(Number(o) + 16000000));
    for (const m of mem) if (!ids.has(m)) ids.set(m, ids.size);
    if (gS) rowsT.push({ mem, g: gS, y: wS / gS - pS });
    if (gO) rowsT.push({ mem, g: gO, y: wO / gO - (1 - pS) });
  }
  const K = ids.size;
  if (!K) return {};
  const A = Array.from({ length: K }, (_, i) => { const r = new Float64Array(K); r[i] = lambda; return r; });
  const bv = new Float64Array(K);
  for (const t of rowsT) {
    const ix = t.mem.map((m) => ids.get(m));
    for (const i of ix) { bv[i] += t.g * t.y; for (const j of ix) A[i][j] += t.g; }
  }
  // Gauss-Seidel (A is symmetric positive definite)
  const x = new Float64Array(K);
  for (let it = 0; it < 200; it++) for (let i = 0; i < K; i++) { let s2 = bv[i]; for (let j = 0; j < K; j++) if (j !== i) s2 -= A[i][j] * x[j]; x[i] = s2 / A[i][i]; }
  return Object.fromEntries([...ids].map(([id, i]) => [id, x[i]]));
}

function split(trainList, testDay) {
  const tr = sum(trainList), te = sum([testDay]);
  const fitRows = [...tr.values()].filter((a) => a.n >= FIT_MIN).map(brawlerRows);
  const site = fitModel(fitRows), flat = fitModel(fitRows, () => 0), old = oldFit(fitRows);
  const methods = {
    'Site (fitted, presence prior)': (rows) => new Map(scoreRows(rows, site, flat).map((r) => [r.id, r.score])),
    'Site, a quarter of the fitted K': (rows) => new Map(scoreRows(rows, { ...site, K: site.K / 4 }, flat).map((r) => [r.id, r.score])),
    'Fitted, shrink to 50%': (rows) => new Map(scoreRows(rows, flat, flat).map((r) => [r.id, r.score])),
    'Site before fix (no intercept)': (rows) => oldScores(rows, old.K, old.slope),
    'Fixed: 40 games to 50%': (rows) => new Map(rows.filter((r) => r.g >= 10).map((r) => [r.id, (0.5 * r.g + r.excess + 20) / (r.g + 40)])),
    'Raw win rate (10+ games)': (rows) => new Map(rows.filter((r) => r.g >= 10).map((r) => [r.id, 0.5 + r.excess / r.g])),
    'Most picked': (rows) => new Map(rows.filter((r) => r.g >= 10).map((r) => [r.id, r.g])),
  };
  const out = Object.fromEntries(Object.keys(methods).map((k) => [k, { se: 0, noise: 0, w: 0, top: 0, topW: 0 }]));
  const rapmOut = { top: 0, topW: 0 };
  let maps = 0, testGames = 0;
  for (const [k, a] of tr) {
    const b = te.get(k);
    if (!b || a.n < FIT_MIN || b.n < TEST_MIN) continue;
    maps++; testGames += b.n;
    const test = new Map(brawlerRows(b).map((r) => [r.id, r]));
    const rows = brawlerRows(a);
    for (const [name, fn] of Object.entries(methods)) {
      const est = fn(rows), o = out[name];
      if (name !== 'Most picked') for (const [id, p] of est) {
        const t = test.get(id); if (!t || t.g < 2) continue;
        const y = 0.5 + t.excess / t.g, yc = Math.min(1, Math.max(0, y));
        o.se += t.g * (y - p) ** 2; o.noise += (yc * (1 - yc) * t.g) / (t.g - 1); o.w += t.g;
      }
      for (const [id] of [...est].sort((x, y) => y[1] - x[1]).slice(0, 5)) { const t = test.get(id); if (t) { o.top += t.excess; o.topW += t.g; } }
    }
    const bt = rapm(a, 50);
    const ranked = rows.filter((r) => r.g >= 10 && bt[r.id] != null).sort((x, y) => bt[y.id] - bt[x.id]);
    for (const r of ranked.slice(0, 5)) { const t = test.get(r.id); if (t) { rapmOut.top += t.excess; rapmOut.topW += t.g; } }
  }
  const res = {};
  for (const [name, o] of Object.entries(out)) res[name] = {
    miss: o.w ? 100 * Math.sqrt(Math.max(0, (o.se - o.noise) / o.w)) : NaN,
    top: o.topW ? 50 + (100 * o.top) / o.topW : NaN,
  };
  res['Teammate-adjusted (RAPM, ridge 50)'] = { miss: NaN, top: rapmOut.topW ? 50 + (100 * rapmOut.top) / rapmOut.topW : NaN };
  return { maps, testGames, res, site, flat };
}

// Extra noise check: are results noisier than coin flips (the same players repeat a brawler)?
// Compare a brawler's rate on odd vs even days: with only coin-flip noise, the ratio is about 1.
function dispersion() {
  const odd = sum(days.filter((_, i) => i % 2)), even = sum(days.filter((_, i) => !(i % 2)));
  let obs = 0, exp = 0;
  for (const [k, a] of odd) {
    const b = even.get(k); if (!b || a.n < FIT_MIN || b.n < FIT_MIN) continue;
    const rb = new Map(brawlerRows(b).map((r) => [r.id, r]));
    for (const r of brawlerRows(a)) {
      const t = rb.get(r.id); if (!t || r.g < 30 || t.g < 30) continue;
      const h = (r.g * t.g) / (r.g + t.g);
      obs += h * (r.excess / r.g - t.excess / t.g) ** 2; exp += 0.25; // true-rate drift between halves would add to obs too
    }
  }
  return obs / exp;
}

const splits = [];
for (let i = MIN_TRAIN_DAYS; i < days.length; i++) {
  const s = split(days.slice(0, i), days[i]);
  if (!s.maps) continue;
  splits.push({ date: days[i].date, ...s });
  console.log(`test ${days[i].date}: ${s.maps} maps, ${s.testGames} games; fitted K ${s.site.K} (flat ${s.flat.K}), slope ${(100 * s.site.slope).toFixed(2)}, intercept ${(100 * s.site.intercept).toFixed(2)}`);
}
const names = Object.keys(splits[0].res), SITE = 'Site (fitted, presence prior)';
const W = splits.reduce((t, s) => t + s.testGames, 0);
const wmean = (f) => splits.reduce((t, s) => t + s.testGames * f(s), 0) / W;
// paired difference vs the site, SE from the spread across days (game-weighted, effective n)
function paired(f) {
  const d = splits.map((s) => ({ w: s.testGames, v: f(s) })).filter((x) => Number.isFinite(x.v));
  const m = d.reduce((t, x) => t + x.w * x.v, 0) / d.reduce((t, x) => t + x.w, 0);
  const neff = d.reduce((t, x) => t + x.w, 0) ** 2 / d.reduce((t, x) => t + x.w * x.w, 0);
  const v = d.reduce((t, x) => t + x.w * (x.v - m) ** 2, 0) / d.reduce((t, x) => t + x.w, 0);
  return { m, se: Math.sqrt(v / Math.max(1, neff - 1)), wins: d.filter((x) => x.v > 0).length, n: d.length, neff };
}
console.log(`\n=== forward-in-time, ${splits.length} test days, group ${GROUP}, ${W} test games ===`);
console.log('method                               miss (pts)  vs site        top 5    vs site');
for (const k of names) {
  const miss = wmean((s) => s.res[k].miss), top = wmean((s) => s.res[k].top);
  const dm = paired((s) => s.res[k].miss - s.res[SITE].miss), dt = paired((s) => s.res[k].top - s.res[SITE].top);
  const f = (x, d) => (Number.isFinite(x.m) && k !== SITE ? `${x.m >= 0 ? '+' : ''}${x.m.toFixed(2)}±${x.se.toFixed(2)}`.padEnd(13) : ''.padEnd(13));
  console.log(`${k.padEnd(36)} ${Number.isFinite(miss) ? miss.toFixed(2).padStart(6) : '     -'}      ${f(dm)} ${top.toFixed(2).padStart(6)}%   ${f(dt)}`);
}
console.log(`days the site wins on miss: ${names.filter((k) => k !== SITE && Number.isFinite(splits[0].res[k].miss)).map((k) => `${k}: ${splits.filter((s) => s.res[SITE].miss < s.res[k].miss).length}/${splits.length}`).join('; ')}`);
console.log(`effective number of test days (game-weighted): ${(W ** 2 / splits.reduce((t, s) => t + s.testGames ** 2, 0)).toFixed(1)}`);
console.log(`\nodd/even-day dispersion (1 = coin-flip noise only): ${dispersion().toFixed(2)}`);
