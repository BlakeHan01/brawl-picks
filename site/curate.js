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
  otherGear: 0.5, // owns 2+ gears, but not the pair skilled players run (when that's clear)
  noHypercharge: 1.5,
  buffieMissing: 1.5, // per missing buffie (3). Buffies replaced power 12 and boost gadget, star power and
  // hypercharge; early Ranked data put a missing one at about -3.8 points (noisy), so 1.5 is a cautious middle
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
  else if (build.gear?.[3] && !build.gear[0].every((g) => gears.includes(g))) miss('Not the top gears', P.otherGear ?? PENALTY.otherGear);
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
  // Tier first (S..D, what the card shows), then the one that's ready (fewest missing pieces),
  // then the exact number: inside a tier the gaps between brawlers are small, while a missing
  // piece is something you feel in the game.
  const rank = (c) => TIERS.findIndex(([t]) => t === tierOf(c.curated));
  return out.sort((a, b) => rank(a) - rank(b) || a.missing.length - b.missing.length || b.curated - a.curated || b.row[1] - a.row[1]);
}

// Player tags use these characters only; "O" is typed for "0" a lot.
export function normalizeTag(raw) {
  const t = String(raw || '').trim().replace(/^#/, '').toUpperCase().replace(/O/g, '0');
  return /^[0289PYLQGRJCUV]{3,12}$/.test(t) ? t : null;
}

// The game API lists buffies (all false) for every brawler, even ones that have none in the game.
// Keep buffies only for brawlers that really have them (data.buffies); without that list, ignore
// buffies entirely rather than count them as missing.
export function withRealBuffies(profile, buffyIds) {
  if (!profile?.brawlers) return profile;
  const has = new Set((buffyIds || []).map(Number));
  return { ...profile, brawlers: profile.brawlers.map((b) => (b.buffies && !has.has(Number(b.id)) ? (({ buffies, ...rest }) => rest)(b) : b)) };
}

// Tiers: how much more often (win-rate points) good players win with a brawler here than with an
// average one (score 50). Fixed cut-offs, the same on every map, so a tier means the same thing
// everywhere: S (+5.5) is 0-4 brawlers per map (some maps have none), C is around average. A tier is easier to read in a 15-second draft than "56.4%".
export const TIERS = [['S', 5.5], ['A', 3.5], ['B', 1.5], ['C', 0], ['D', -Infinity]];
export const tierOf = (score) => TIERS.find(([, t]) => score - 50 >= t)[0];
