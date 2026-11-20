#!/usr/bin/env node
// Temporary: "first choice of skilled players". Across ALL brawlers in Legendary+ players' profiles,
// how often does a brawler have exactly one star power / gadget, or exactly two gears? Is the
// favourite stable between two halves of the players?
import { official, listOf, pool } from './lib.mjs';
const top = listOf(await official('/rankings/global/players?limit=100'));
const logs = await pool(top, 8, (p) => official(`/players/${encodeURIComponent(p.tag)}/battlelog`));
const tags = new Set();
for (const lg of logs) for (const it of listOf(lg)) {
  const bt = it.battle || {};
  if (bt.type !== 'soloRanked' || !Array.isArray(bt.teams)) continue;
  for (const p of bt.teams.flat()) if (p.brawler?.trophies >= 16) tags.add(p.tag);
}
const list = [...tags].slice(0, 600);
const profs = await pool(list, 8, (t) => official(`/players/${encodeURIComponent(t)}`));
const names = {};
const tot = { sp: [0, 0], gad: [0, 0], gear: [0, 0] }; // [eligible, informative]
const half = [{}, {}]; // half -> key "sp:brawler" -> {choice: n}
const add = (h, k, c) => { const o = (h[k] ||= {}); o[c] = (o[c] || 0) + 1; };
profs.forEach((pr, i) => {
  if (!pr) return;
  for (const b of pr.brawlers || []) {
    names[b.id] = b.name;
    for (const x of [...(b.starPowers || []), ...(b.gadgets || []), ...(b.gears || [])]) names[x.id] = x.name;
    if (b.power >= 9) { tot.sp[0]++; if (b.starPowers?.length === 1) { tot.sp[1]++; add(half[i % 2], `sp:${b.id}`, b.starPowers[0].id); } }
    if (b.power >= 7) { tot.gad[0]++; if (b.gadgets?.length === 1) { tot.gad[1]++; add(half[i % 2], `gad:${b.id}`, b.gadgets[0].id); } }
    if (b.power >= 8) { tot.gear[0]++; if (b.gears?.length === 2) { tot.gear[1]++; add(half[i % 2], `gear:${b.id}`, b.gears.map((g) => g.id).sort().join('+')); } }
  }
});
console.log(`profiles: ${profs.filter(Boolean).length}`);
for (const [k, [e, n]] of Object.entries(tot)) console.log(`${k}: ${n} of ${e} eligible brawler entries informative (${(100 * n / e).toFixed(1)}%)`);
for (const kind of ['sp', 'gad', 'gear']) {
  let agree = 0, both = 0, enough = 0;
  const keys = new Set([...Object.keys(half[0]), ...Object.keys(half[1])].filter((k) => k.startsWith(kind + ':')));
  for (const k of keys) {
    const a = half[0][k] || {}, b = half[1][k] || {};
    const na = Object.values(a).reduce((s, x) => s + x, 0), nb = Object.values(b).reduce((s, x) => s + x, 0);
    if (na + nb >= 30) enough++;
    if (na < 15 || nb < 15) continue;
    both++;
    const ta = Object.entries(a).sort((x, y) => y[1] - x[1])[0][0], tb = Object.entries(b).sort((x, y) => y[1] - x[1])[0][0];
    if (ta === tb) agree++;
  }
  console.log(`${kind}: ${keys.size} brawlers seen, ${enough} with 30+ samples; top choice same in both halves for ${agree}/${both} (15+ per half)`);
}
const show = (bn) => {
  const id = Object.keys(names).find((k) => names[k] === bn); if (!id) return;
  for (const kind of ['sp', 'gad', 'gear']) {
    const c = {}; for (const h of half) for (const [ch, n] of Object.entries(h[`${kind}:${id}`] || {})) c[ch] = (c[ch] || 0) + n;
    const tot = Object.values(c).reduce((s, x) => s + x, 0);
    console.log(`  ${bn} ${kind} (n=${tot}): ` + Object.entries(c).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([ch, n]) => `${ch.split('+').map((x) => names[x]).join('+')} ${(100 * n / tot).toFixed(0)}%`).join(', '));
  }
};
for (const bn of ['BULL', 'GIGI', 'KIT', 'LOU', 'MR. P', 'SHELLY', 'EDGAR']) show(bn);
