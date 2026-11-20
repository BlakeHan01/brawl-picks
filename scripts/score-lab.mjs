#!/usr/bin/env node
// Score lab: which ranking formula best predicts how brawlers do on games it hasn't seen?
// Fit on some days, test on the others (and the reverse), per map, using skill-adjusted results.
//   node scripts/score-lab.mjs [group=rL] [testDays=2026-11-19]
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ROOT } from './lib.mjs';

const GROUP = process.argv[2] || 'rL';
const DIR = resolve(ROOT, process.env.DAILY_DIR || 'data/daily');
const files = (await readdir(DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const testDays = new Set((process.argv[3] || '2026-11-19').split(','));
const days = await Promise.all(files.map(async (f) => ({ date: f.slice(0, 10), d: JSON.parse(await readFile(join(DIR, f), 'utf8')) })));

function sum(list) {
  const maps = new Map();
  for (const { d } of list) for (const [k, m] of Object.entries(d.maps)) {
    const a = m[GROUP]; if (!a?.n) continue;
    const x = maps.get(k) || { n: 0, sw: 0, b: {}, bans: {} };
    x.n += a.n; x.sw += a.sw;
    for (const [id, v] of Object.entries(a.b)) { const s = (x.b[id] ||= [0, 0, 0, 0]); for (let i = 0; i < 4; i++) s[i] += v[i]; }
    for (const [id, c] of Object.entries(a.bans || {})) x.bans[id] = (x.bans[id] || 0) + c;
    maps.set(k, x);
  }
  return maps;
}
// per brawler: games g, skill-adjusted excess wins, pick share, ban share
function rows(a) {
  const pS = a.sw / a.n;
  return Object.entries(a.b).map(([id, [gS, wS, gO, wO]]) => {
    const g = gS + gO;
    return { id, g, ex: wS - gS * pS + (wO - gO * (1 - pS)), ur: g / (2 * a.n), ban: (a.bans[id] || 0) / a.n };
  });
}

// Fit prior mean = 0.5 + beta * log(x / median x) and between-brawler variance tau2 from training rows.
function fitPrior(all, feature) {
  const pts = all.filter((r) => r.g >= 10).map((r) => ({ x: feature(r), y: r.ex / r.g, w: r.g }));
  const xs = pts.map((p) => p.x).sort((a, b) => a - b);
  const med = xs[Math.floor(xs.length / 2)];
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) { const x = p.x - med; sw += p.w; sx += p.w * x; sy += p.w * p.y; sxx += p.w * x * x; sxy += p.w * x * p.y; }
  const vx = sxx - (sx * sx) / sw;
  const beta = vx > 1e-9 ? (sxy - (sx * sy) / sw) / vx : 0;
  const alpha = sy / sw - beta * (sx / sw);
  // tau2 = residual variance minus binomial noise (method of moments), floored
  let num = 0, den = 0;
  for (const p of pts) { const r = p.y - (alpha + beta * (p.x - med)); num += p.w * (r * r - 0.25 / p.w); den += p.w; }
  return { beta, alpha, med, tau2: Math.max(1e-5, num / den) };
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const logPick = (r) => Math.log(Math.max(r.ur, 1e-4));
const logPresence = (r) => Math.log(Math.max(r.ur + r.ban, 1e-4));

function methods(trainAll) {
  const fp = fitPrior(trainAll, logPick);
  const hasBans = trainAll.some((r) => r.ban > 0);
  const fb = hasBans ? fitPrior(trainAll, logPresence) : null;
  const flat = fitPrior(trainAll, () => 0);
  const eb = (f, feat) => (r) => {
    const K = 0.25 / f.tau2; // prior worth K games
    const prior = 0.5 + f.beta * (feat(r) - f.med);
    return (r.g * (0.5 + r.ex / r.g) + K * prior) / (r.g + K);
  };
  const m = {
    'raw (10+ games)': (r) => 0.5 + r.ex / r.g,
    'Current: shrink to 50%, 40 games': (r) => (0.5 * r.g + r.ex + 20) / (r.g + 40),
    'New: pick prior, fixed weight': (r, med) => (0.5 * r.g + r.ex + 40 * (0.5 + 0.02 * clamp(Math.log(r.ur / med), -1.5, 1.5))) / (r.g + 40),
    'Fitted: shrink to 50%': eb(flat, () => 0),
    'Fitted: pick-rate prior': eb(fp, logPick),
  };
  if (fb) m['Fitted: pick+ban prior'] = eb(fb, logPresence);
  return { m, info: { pick: fp, flat, ...(fb ? { presence: fb } : {}) } };
}

function evaluate(trainList, testList, label) {
  const tr = sum(trainList), te = sum(testList);
  const trainAll = [...tr.values()].flatMap(rows);
  const { m, info } = methods(trainAll);
  const res = Object.fromEntries(Object.keys(m).map((k) => [k, { se: 0, w: 0, top: 0, topW: 0 }]));
  res['Most picked'] = { se: NaN, w: 1, top: 0, topW: 0 };
  let maps = 0;
  for (const [k, a] of tr) {
    const b = te.get(k);
    if (!b || a.n < 150 || b.n < 150) continue;
    maps++;
    const testBy = Object.fromEntries(rows(b).map((r) => [r.id, r]));
    const rs = rows(a).filter((r) => r.g >= 10);
    const med = rs.map((r) => r.ur).sort((x, y) => x - y)[Math.floor(rs.length / 2)];
    const score = (name, fn) => {
      const scored = rs.map((r) => ({ r, p: fn(r, med) }));
      for (const { r, p } of scored) { const t = testBy[r.id]; if (t?.g >= 10) { res[name].se += t.g * (0.5 + t.ex / t.g - p) ** 2; res[name].w += t.g; } }
      scored.sort((x, y) => y.p - x.p);
      for (const { r } of scored.slice(0, 5)) { const t = testBy[r.id]; if (t?.g) { res[name].top += t.ex; res[name].topW += t.g; } }
    };
    for (const [name, fn] of Object.entries(m)) score(name, fn);
    score('Most picked', (r) => r.g);
  }
  console.log(`\n=== ${label}: ${maps} maps (group ${GROUP}) ===`);
  for (const [k, f] of Object.entries(info)) console.log(`  fitted ${k}: prior worth ${(0.25 / f.tau2).toFixed(0)} games, slope ${(100 * f.beta).toFixed(2)} pts per e-fold`);
  console.log('  method                               pred. error   top-5 actual win% (games)');
  for (const [k, r] of Object.entries(res)) {
    console.log(`  ${k.padEnd(36)} ${Number.isNaN(r.se) ? '     -     ' : (1e4 * r.se / r.w).toFixed(1).padStart(8) + '   '}   ${(50 + 100 * r.top / r.topW).toFixed(2)}% (${r.topW})`);
  }
}

const test = days.filter((x) => testDays.has(x.date)), train = days.filter((x) => !testDays.has(x.date));
evaluate(train, test, `fit on ${train.map((x) => x.date.slice(5)).join(',')} -> test ${[...testDays].map((x) => x.slice(5)).join(',')}`);
evaluate(test, train, 'reverse');
