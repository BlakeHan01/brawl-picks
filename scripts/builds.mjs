// Best builds from what skilled players actually chose.
//
// The official API never says which gadget, star power or gears a player had equipped; a player
// profile only lists what they own. Skilled players own both star powers and both gadgets for
// the brawlers they play, so ownership says nothing there. But across the ~100 brawlers in a
// Legendary+ player's profile, some brawlers have exactly ONE star power or gadget unlocked: the
// one that player chose to buy first. And many brawlers have exactly TWO gears, which are the two
// that can be equipped. Counting those choices over thousands of Legendary+ players gives:
//   star power / gadget: the "first choice" of skilled players
//   gears: the pair skilled players run
import { titleCase } from './lib.mjs';

// Power level needed before the item can be owned at all.
const MIN_POWER = { sp: 9, gad: 7, gear: 8 };
// Smallest number of choices before we show a recommendation.
export const MIN_SAMPLES = { sp: 20, gad: 20, gear: 20 };

export const blankBuilds = () => ({ v: 1, players: 0, sp: {}, gad: {}, gear: {} });

// profiles: official /players/{tag} responses. names: id -> display name (filled in).
export function tallyBuilds(profiles, counts = blankBuilds(), names = {}) {
  const inc = (o, b, k) => { const x = (o[b] ||= {}); x[k] = (x[k] || 0) + 1; };
  for (const pr of profiles) {
    if (!pr?.brawlers) continue;
    counts.players++;
    for (const b of pr.brawlers) {
      for (const it of [...(b.starPowers || []), ...(b.gadgets || []), ...(b.gears || [])]) {
        if (it?.id && it.name) names[it.id] = titleCase(it.name);
      }
      if (b.power >= MIN_POWER.sp && b.starPowers?.length === 1) inc(counts.sp, b.id, b.starPowers[0].id);
      if (b.power >= MIN_POWER.gad && b.gadgets?.length === 1) inc(counts.gad, b.id, b.gadgets[0].id);
      if (b.power >= MIN_POWER.gear && b.gears?.length === 2) inc(counts.gear, b.id, b.gears.map((g) => g.id).sort((x, y) => x - y).join('+'));
    }
  }
  return counts;
}

// Wilson 95% lower bound of a share.
function lower(k, n) {
  const z = 1.96, p = k / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
}

// list of counts (one per day) ->
//   { brawlerId: { sp: [id, share%, n, clear, runnerUpShare%], gad: [...], gear: [[id, id], share%, n, clear, runnerUp%] } }
// clear = 1 when the top choice beats the runner-up head to head: among players who chose either,
// the low end of the top choice's 95% range is still above half.
export function summarizeBuilds(list) {
  const sum = { sp: {}, gad: {}, gear: {} };
  for (const c of list) for (const k of ['sp', 'gad', 'gear']) {
    for (const [b, choices] of Object.entries(c[k] || {})) {
      const x = (sum[k][b] ||= {});
      for (const [ch, n] of Object.entries(choices)) x[ch] = (x[ch] || 0) + n;
    }
  }
  const out = {};
  for (const k of ['sp', 'gad', 'gear']) {
    for (const [b, choices] of Object.entries(sum[k])) {
      const total = Object.values(choices).reduce((s, n) => s + n, 0);
      if (total < MIN_SAMPLES[k]) continue;
      const sorted = Object.entries(choices).sort((x, y) => y[1] - x[1]);
      const [top, n] = sorted[0];
      const second = sorted[1]?.[1] || 0;
      const pct = (x) => Math.round((1000 * x) / total) / 10;
      const clear = lower(n, n + second) > 0.5 ? 1 : 0;
      (out[b] ||= {})[k] = [k === 'gear' ? top.split('+').map(Number) : Number(top), pct(n), total, clear, pct(second)];
    }
  }
  return out;
}
