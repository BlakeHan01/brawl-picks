// Curated pick: the player's own best brawlers for one map.
//
// Start from the map's ranking (our score), keep only brawlers the player owns, and take points
// off for anything that's missing from their build, so a fully built brawler beats a slightly
// stronger one that isn't. Brawlers below power 9 (no star power possible) are left out.
//
// rows:    map rows [brawlerId, score %, win %, pick %, games, ban %], best score first
// profile: Worker /player response { brawlers: [{ id, power, starPowers, gadgets, gears, hyperCharges, buffies? }] }
// builds:  brawlerId -> { sp: [id, share, n, clear], gad: [...], gear: [[id, id], ...] } (site data)

// Points taken off the score (score is a win-rate estimate in %).
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

// -> [{ row, own, missing, penalty, curated }], best first.
export function curate(rows, profile, builds = {}) {
  const owned = new Map((profile?.brawlers || []).map((b) => [Number(b.id), b]));
  const out = [];
  for (const row of rows) {
    const own = owned.get(Number(row[0]));
    if (!own || own.power < MIN_POWER) continue;
    const { missing, penalty } = readiness(own, builds[row[0]]);
    out.push({ row, own, missing, penalty, curated: Math.round((row[1] - penalty) * 10) / 10 });
  }
  return out.sort((a, b) => b.curated - a.curated || b.row[1] - a.row[1]);
}

// Player tags use these characters only; "O" is typed for "0" a lot.
export function normalizeTag(raw) {
  const t = String(raw || '').trim().replace(/^#/, '').toUpperCase().replace(/O/g, '0');
  return /^[0289PYLQGRJCUV]{3,12}$/.test(t) ? t : null;
}
