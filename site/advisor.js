// Upgrade advisor: what to spend coins and power points on.
//
// Rule-based. Your "strength" on the current Ranked maps is, per map, the average of your top 3
// Curated pick scores (map score minus what missing build pieces cost; see curate.js), averaged
// over the maps. An upgrade is worth how much it raises that. Upgrades are grouped per brawler into
// packages (power 10 -> 11 only pays off once the earlier steps are done), and the plan takes the
// package with the most gain per coin that fits what you have, then the next, until nothing fits.
import { readiness, MIN_POWER } from './curate.js';

// In-game prices. LEVEL[n] = [coins, power points] to go from power n-1 to n.
export const LEVEL = { 2: [20, 20], 3: [35, 30], 4: [75, 50], 5: [140, 80], 6: [290, 130], 7: [480, 210], 8: [800, 340], 9: [1250, 550], 10: [1875, 890], 11: [2800, 1440] };
export const PRICE = { gadget: 1000, starPower: 2000, gear: 1000, hypercharge: 5000, buffie: [1000, 2000] }; // buffie: per Claw Machine pull
// Buffies come from the Claw Machine: one trio of brawlers per machine (9 Buffies), every pull gives
// a random Buffie you don't own yet, all equally likely, no duplicates (Supercell support). The pull
// order is a random shuffle, so with R Buffies left in the machine and m of them for this brawler,
// each of the m arrives on average every (R + 1) / (m + 1) pulls. The API doesn't say which brawlers
// share a machine, so we assume the other two still have all 6 of theirs left (the cautious case).
export const MACHINE_OTHERS = 6;
export const pullsPerBuffie = (missing, others = MACHINE_OTHERS) => (missing + others + 1) / (missing + 1);
// When comparing value, a power point counts as half a coin (they are easier to get).
export const PP_WEIGHT = 0.5;
// An empty top-3 slot on a map counts as a weak pick.
const EMPTY_SLOT = 45;

const clone = (o) => ({ ...o, starPowers: [...(o.starPowers || [])], gadgets: [...(o.gadgets || [])], gears: [...(o.gears || [])], hyperCharges: [...(o.hyperCharges || [])], buffies: { ...(o.buffies || {}) } });

// The upgrades still open for one owned brawler, in buying order. Each step: { kind, label, coins, pp, item, own (after) }.
// kind: power | gadget | starPower | gear | hypercharge | buffie. item: item id when we know which one to buy.
export function upgradeSteps(own, build = {}, names = {}) {
  const out = [];
  let cur = clone(own);
  const add = (kind, label, coins, pp, item, apply) => { const next = clone(cur); apply(next); out.push({ kind, label, coins, pp, item: item ?? null, own: next }); cur = next; };
  const nm = (id, fallback) => (id != null && names[id]) || fallback;
  if (cur.power < MIN_POWER) {
    let c = 0, p = 0;
    for (let l = cur.power + 1; l <= MIN_POWER; l++) { c += LEVEL[l][0]; p += LEVEL[l][1]; }
    add('power', `Power ${cur.power} → ${MIN_POWER}`, c, p, null, (x) => { x.power = MIN_POWER; });
  }
  const gadTop = build.gad?.[0], spTop = build.sp?.[0];
  // Missing, or only the other one when skilled players clearly prefer the top one.
  if (!cur.gadgets.length || (build.gad?.[3] && !cur.gadgets.includes(gadTop))) add('gadget', nm(gadTop, 'Gadget'), PRICE.gadget, 0, gadTop, (x) => x.gadgets.push(gadTop ?? -1));
  if (!cur.starPowers.length || (build.sp?.[3] && !cur.starPowers.includes(spTop))) add('starPower', nm(spTop, 'Star power'), PRICE.starPower, 0, spTop, (x) => x.starPowers.push(spTop ?? -1));
  for (let l = cur.power + 1; l <= 11; l++) add('power', `Power ${l - 1} → ${l}`, LEVEL[l][0], LEVEL[l][1], null, (x) => { x.power = l; });
  const wanted = build.gear?.[0] || [];
  while (cur.gears.length < 2) {
    const g = wanted.find((x) => !cur.gears.includes(x));
    add('gear', nm(g, 'Gear'), PRICE.gear, 0, g, (x) => x.gears.push(g ?? -1 - x.gears.length));
  }
  if (!cur.hyperCharges.length) add('hypercharge', 'Hypercharge', PRICE.hypercharge, 0, null, (x) => x.hyperCharges.push(-1));
  if (own.buffies) {
    const keys = ['gadget', 'starPower', 'hyperCharge'].filter((k) => !cur.buffies[k]);
    const pulls = pullsPerBuffie(keys.length);
    for (const k of keys) {
      // which one you get is random, so each step is "one more Buffie" at the expected cost
      const st = { pulls };
      add('buffie', 'Buffie', Math.round(PRICE.buffie[0] * pulls), Math.round(PRICE.buffie[1] * pulls), null, (x) => { x.buffies[k] = true; });
      Object.assign(out[out.length - 1], st);
    }
  }
  return out;
}

// maps: [{ rows: [[brawlerId, score, ...]] }] (the Ranked pool). builds: brawlerId -> best build. P: piece costs.
// -> { strength, chains: { brawlerId: [{ ...step, gain, top: [[mapIndex, rank], ...] }] } }
//    gain: how much the step raises strength (on top of the steps before it); top: maps where the
//    brawler is in your top 3 after the step.
export function upgradeChains(profile, maps, builds = {}, P, names = {}) {
  const owned = (profile?.brawlers || []).map((b) => ({ ...b, id: Number(b.id) }));
  const score = maps.map((m) => new Map((m.rows || []).map((r) => [Number(r[0]), r[1]])));
  const value = (own, mi) => {
    const s = score[mi].get(own.id);
    return s == null || own.power < MIN_POWER ? null : s - readiness(own, builds[own.id], P).penalty;
  };
  // per map: everyone's current Curated value, best first
  const now = maps.map((_, mi) => owned.map((o) => [o.id, value(o, mi)]).filter((x) => x[1] != null).sort((a, b) => b[1] - a[1]));
  const mapStrength = (list) => (list.slice(0, 3).reduce((s, x) => s + x[1], 0) + EMPTY_SLOT * Math.max(0, 3 - list.length)) / 3;
  // top 3 on map mi if brawler id had value v (null = can't be picked)
  const top3With = (mi, id, v) => {
    const list = [];
    for (const x of now[mi]) { if (x[0] !== id) list.push(x); if (list.length === 3) break; }
    if (v != null) list.push([id, v]);
    return list.sort((a, b) => b[1] - a[1]).slice(0, 3);
  };
  const strength = maps.length ? now.reduce((s, l) => s + mapStrength(l), 0) / maps.length : 0;
  const chains = {};
  for (const o of owned) {
    const steps = upgradeSteps(o, builds[o.id], names);
    if (!steps.length) continue;
    let prev = strength;
    const out = steps.map((st) => {
      let total = 0;
      const top = [];
      for (let mi = 0; mi < maps.length; mi++) {
        const t = top3With(mi, o.id, value(st.own, mi));
        total += mapStrength(t);
        const r = t.findIndex((x) => x[0] === o.id);
        if (r >= 0) top.push([mi, r + 1]);
      }
      const s = total / maps.length;
      const gain = s - prev;
      prev = s;
      const { own, ...rest } = st;
      return { ...rest, gain, top };
    });
    if (out.some((x) => x.gain > 0.001)) chains[o.id] = out;
  }
  return { strength, chains };
}

const weight = (c, p) => c + p * PP_WEIGHT;

// Best package for one brawler starting at step `from`, within what's left: the run of steps
// with the most gain per coin.
export function bestPackage(chain, from = 0, coinsLeft = Infinity, ppLeft = Infinity) {
  let c = 0, p = 0, g = 0, best = null;
  for (let k = from; k < chain.length; k++) {
    c += chain[k].coins; p += chain[k].pp; g += chain[k].gain;
    if (c > coinsLeft || p > ppLeft) break;
    const perK = g / (weight(c, p) / 1000);
    if (g > 0.001 && (!best || perK > best.perK)) best = { from, to: k, coins: c, pp: p, gain: g, perK };
  }
  return best;
}

// -> { list: [{ id, from, to, coins, pp, gain }], coinsLeft, ppLeft, next: { id: step index } }
export function makePlan(chains, coins, pp, maxPicks = 12) {
  const next = {}, picks = [];
  let cl = coins, pl = pp;
  while (picks.length < 40) {
    let pick = null;
    for (const id of Object.keys(chains)) {
      const b = bestPackage(chains[id], next[id] || 0, cl, pl);
      if (b && (!pick || b.perK > pick.perK)) pick = { id, ...b };
    }
    if (!pick) break;
    picks.push(pick);
    next[pick.id] = pick.to + 1;
    cl -= pick.coins; pl -= pick.pp;
  }
  // one card per brawler: join back-to-back packages of the same brawler
  const list = [];
  for (const b of picks) {
    const m = list.find((x) => x.id === b.id && x.to + 1 === b.from);
    if (m) Object.assign(m, { to: b.to, coins: m.coins + b.coins, pp: m.pp + b.pp, gain: m.gain + b.gain });
    else list.push({ id: b.id, from: b.from, to: b.to, coins: b.coins, pp: b.pp, gain: b.gain });
  }
  // a cap keeps a big stash readable; anything cut is simply not spent
  const shown = list.slice(0, maxPicks);
  const spentC = shown.reduce((s, x) => s + x.coins, 0), spentP = shown.reduce((s, x) => s + x.pp, 0);
  const nextShown = {};
  for (const x of shown) nextShown[x.id] = x.to + 1;
  return { list: shown, coinsLeft: coins - spentC, ppLeft: pp - spentP, next: nextShown };
}

// Best packages that cost more than what's left: what to save up for.
export function saveUpFor(chains, plan, n = 3) {
  return Object.keys(chains)
    .map((id) => { const b = bestPackage(chains[id], plan.next[id] || 0); return b && { id, ...b }; })
    .filter((b) => b && (b.coins > plan.coinsLeft || b.pp > plan.ppLeft))
    .sort((a, b) => b.perK - a.perK)
    .slice(0, n);
}
