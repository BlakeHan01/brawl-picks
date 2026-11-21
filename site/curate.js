// Curated pick: the player's own best brawlers for one map.
//
// Keep only brawlers the player owns (power 9+), and order them by our score for the map minus
// what each missing build piece costs. The costs are measured from data by the stats job
// (data.costs: within-player comparison of games with and without each piece); PENALTY below is
// only the fallback when that data isn't there yet.
//
// rows:    map rows [brawlerId, score %, win %, pick %, games, ban %], best score first
// profile: Worker /player response { brawlers: [{ id, power, starPowers, gadgets, gears, hyperCharges, buffies? }] }
// builds:  brawlerId -> { sp: [id, share, n, clear], gad: [...], gear: [[id, id], ...] } (site data)

// Fallback costs in win-rate points (the measured ones replace these).
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
// P: costs per piece { powerLevel, noStarPower, otherStarPower, noGadget, otherGadget, gearMissing, noHypercharge, buffieMissing }
export function readiness(own, build = {}, P = PENALTY) {
  const missing = [];
  let penalty = 0;
  const miss = (label, pts) => { missing.push(label); penalty += pts; };
  if (own.power < 11) miss(`Power ${own.power}`, P.powerLevel * (11 - own.power));
  const sp = own.starPowers || [], gad = own.gadgets || [], gears = own.gears || [];
  if (!sp.length) miss('No star power', P.noStarPower);
  else if (build.sp?.[3] && !sp.includes(build.sp[0])) miss('Not the top star power', P.otherStarPower);
  if (!gad.length) miss('No gadget', P.noGadget);
  else if (build.gad?.[3] && !gad.includes(build.gad[0])) miss('Not the top gadget', P.otherGadget);
  if (gears.length < 2) miss(gears.length ? '1 gear missing' : '2 gears missing', P.gearMissing * (2 - gears.length));
  if (!(own.hyperCharges || []).length) miss('No hypercharge', P.noHypercharge);
  if (own.buffies) {
    const have = ['gadget', 'starPower', 'hyperCharge'].filter((k) => own.buffies[k]).length;
    if (have < 3) miss(`Buffies ${have}/3`, P.buffieMissing * (3 - have));
  }
  return { missing, penalty: Math.round(penalty * 10) / 10 };
}

// Measured costs (data.costs.pieces) -> P. Falls back to PENALTY per piece.
// Only used once enough Ranked games are measured; until then the fallback estimates apply.
export const MIN_COST_GAMES = 20000;
export function costsFrom(costs) {
  const P = { ...PENALTY };
  if (!(costs?.n >= MIN_COST_GAMES)) return P;
  for (const [k, v] of Object.entries(costs?.pieces || {})) if (k in P && Number.isFinite(v.penalty)) P[k] = v.penalty;
  return P;
}

// -> [{ row, own, missing, penalty, curated }], best first. curated = map score - build costs.
export function curate(rows, profile, builds = {}, P = PENALTY) {
  const owned = new Map((profile?.brawlers || []).map((b) => [Number(b.id), b]));
  const out = [];
  for (const row of rows) {
    const own = owned.get(Number(row[0]));
    if (!own || own.power < MIN_POWER) continue;
    const { missing, penalty } = readiness(own, builds[row[0]], P);
    out.push({ row, own, missing, penalty, curated: Math.round((row[1] - penalty) * 10) / 10 });
  }
  return out.sort((a, b) => b.curated - a.curated || a.missing.length - b.missing.length || b.row[1] - a.row[1]);
}

// Player tags use these characters only; "O" is typed for "0" a lot.
export function normalizeTag(raw) {
  const t = String(raw || '').trim().replace(/^#/, '').toUpperCase().replace(/O/g, '0');
  return /^[0289PYLQGRJCUV]{3,12}$/.test(t) ? t : null;
}
