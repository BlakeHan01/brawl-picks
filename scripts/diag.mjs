#!/usr/bin/env node
// Temporary: can we infer builds? Among Legendary+ players, how often does a played brawler
// have exactly one star power / one gadget / at most two gears (so the equipped ones are known)?
import { official, listOf, pool } from './lib.mjs';
const top = listOf(await official('/rankings/global/players?limit=60'));
const logs = await pool(top, 8, (p) => official(`/players/${encodeURIComponent(p.tag)}/battlelog`));
const seen = new Map(); // tag -> Set(brawlerId) played in Legendary+ ranked games
for (const lg of logs) for (const it of listOf(lg)) {
  const bt = it.battle || {};
  if (bt.type !== 'soloRanked' || !Array.isArray(bt.teams)) continue;
  for (const p of bt.teams.flat()) {
    if (!(p.brawler?.trophies >= 16)) continue;
    if (!seen.has(p.tag)) seen.set(p.tag, new Set());
    seen.get(p.tag).add(p.brawler.id);
  }
}
const tags = [...seen.keys()].slice(0, 400);
const profs = await pool(tags, 8, (t) => official(`/players/${encodeURIComponent(t)}`));
const c = { pairs: 0, sp: {}, gad: {}, gear: {}, hc: {} };
const inc = (o, k) => (o[k] = (o[k] || 0) + 1);
for (let i = 0; i < tags.length; i++) {
  const pr = profs[i]; if (!pr) continue;
  for (const b of pr.brawlers || []) {
    if (!seen.get(tags[i]).has(b.id)) continue;
    c.pairs++;
    inc(c.sp, b.starPowers?.length ?? 0); inc(c.gad, b.gadgets?.length ?? 0);
    inc(c.gear, b.gears?.length ?? 0); inc(c.hc, b.hyperCharges?.length ?? 0);
  }
}
console.log(`players with profiles: ${profs.filter(Boolean).length}; (player, brawler they played in Legendary+ Ranked) pairs: ${c.pairs}`);
console.log('star powers owned ->', c.sp);
console.log('gadgets owned ->', c.gad);
console.log('gears owned ->', c.gear);
console.log('hypercharges owned ->', c.hc);
