// Curated pick: the player's own best brawlers for one map.
//
// Keep only brawlers the player owns, then order in three groups, by our score within each:
//   1. power 11 and fully built (the star power and gadget skilled players pick when that's clear,
//      2 gears, hypercharge, all 3 buffies)
//   2. power 11, something missing
//   3. below power 11 (power 9-10), at the back
// Brawlers below power 9 (no star power possible) are left out.
//
// rows:    map rows [brawlerId, score %, win %, pick %, games, ban %], best score first
// profile: Worker /player response { brawlers: [{ id, power, starPowers, gadgets, gears, hyperCharges, buffies? }] }
// builds:  brawlerId -> { sp: [id, share, n, clear], gad: [...], gear: [[id, id], ...] } (site data)

// How far a brawler is from fully built (shown as a hint; ordering uses the groups above).
export const PENALTY = {
  powerLevel: 2.5, // per level below 11
  noStarPower: 3,
  otherStarPower: 1, // owns a star power, but not the one skilled players pick (when that's clear)
  noGadget: 1.5,
  otherGadget: 0.5,
  gearMissing: 0.75, // per missing gear slot (2 slots)
  noHypercharge: 1.5,
  buffieMissing: 0.4, // per missing buffie (3)
};
export const MIN_POWER = 9;

// What's missing from one owned brawler's build, and the points it costs.
export function readiness(own, build = {}) {
  const missing = [];
  let penalty = 0;
  const miss = (label, pts) => { missing.push(label); penalty += pts; };
  if (own.power < 11) miss(`Power ${own.power}`, PENALTY.powerLevel * (11 - own.power));
  const sp = own.starPowers || [], gad = own.gadgets || [], gears = own.gears || [];
  if (!sp.length) miss('No star power', PENALTY.noStarPower);
  else if (build.sp?.[3] && !sp.includes(build.sp[0])) miss('Not the top star power', PENALTY.otherStarPower);
  if (!gad.length) miss('No gadget', PENALTY.noGadget);
  else if (build.gad?.[3] && !gad.includes(build.gad[0])) miss('Not the top gadget', PENALTY.otherGadget);
  if (gears.length < 2) miss(gears.length ? '1 gear missing' : '2 gears missing', PENALTY.gearMissing * (2 - gears.length));
  if (!(own.hyperCharges || []).length) miss('No hypercharge', PENALTY.noHypercharge);
  if (own.buffies) {
    const have = ['gadget', 'starPower', 'hyperCharge'].filter((k) => own.buffies[k]).length;
    if (have < 3) miss(`Buffies ${have}/3`, PENALTY.buffieMissing * (3 - have));
  }
  return { missing, penalty: Math.round(penalty * 10) / 10 };
}

// -> [{ row, own, missing, penalty, tier, curated }], best first. tier 0 = power 11 fully built,
// 1 = power 11 with something missing, 2 = below power 11. curated = the map score.
export function curate(rows, profile, builds = {}) {
  const owned = new Map((profile?.brawlers || []).map((b) => [Number(b.id), b]));
  const out = [];
  for (const row of rows) {
    const own = owned.get(Number(row[0]));
    if (!own || own.power < MIN_POWER) continue;
    const { missing, penalty } = readiness(own, builds[row[0]]);
    const tier = own.power < 11 ? 2 : missing.length ? 1 : 0;
    out.push({ row, own, missing, penalty, tier, curated: row[1] });
  }
  return out.sort((a, b) => a.tier - b.tier || b.row[1] - a.row[1]);
}

// Player tags use these characters only; "O" is typed for "0" a lot.
export function normalizeTag(raw) {
  const t = String(raw || '').trim().replace(/^#/, '').toUpperCase().replace(/O/g, '0');
  return /^[0289PYLQGRJCUV]{3,12}$/.test(t) ? t : null;
}
