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

export const blankBuilds = () => ({ v: 1, players: 0, sp: {}, gad: {}, gear: {}, buf: {} });

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
      // The API lists buffies (all false) for every brawler, even ones that have none in the game.
      // Counting who owns any tells us which brawlers really have buffies.
      if (b.buffies && Object.values(b.buffies).some(Boolean)) { counts.buf ||= {}; counts.buf[b.id] = (counts.buf[b.id] || 0) + 1; }
      if (b.power >= MIN_POWER.gear && b.gears?.length === 2) inc(counts.gear, b.id, b.gears.map((g) => g.id).sort((x, y) => x - y).join('+'));
    }
  }
  return counts;
}

// Brawlers that have buffies in the game: owned by at least `min` skilled players in the window.
export function buffyBrawlers(list, min = 3) {
  const sum = {};
  for (const c of list) for (const [b, n] of Object.entries(c?.buf || {})) sum[b] = (sum[b] || 0) + n;
  return Object.keys(sum).filter((b) => sum[b] >= min).map(Number).sort((a, b) => a - b);
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

// ---------- What missing build pieces cost (within-player comparison) ----------
// For players whose profile AND battle log we read, each of their games gets the build of the
// brawler they used: power (from the battle log), hypercharge, buffies, star power, gadget, gears
// (from the profile). Comparing a player's games with each other (each player's own average win
// rate is subtracted) removes "better players own more stuff". A linear model then gives how many
// win-rate points each missing piece costs. Only the sums are stored, so days add up.
export const EFFECTS = ['powerLevel', 'noHypercharge', 'buffieMissing', 'noStarPower', 'otherStarPower', 'noGadget', 'otherGadget', 'gearMissing'];
const K = EFFECTS.length;
export const blankEffects = () => ({ v: 3, n: 0, players: 0, nz: Array(K).fill(0), xtx: Array(K * K).fill(0), xty: Array(K).fill(0) });

// own: profile brawler; build: { sp, gad } summary (top choice + clear flag); power: from the battle.
// hasBuffies: whether this brawler has buffies in the game at all.
export function featuresFor(own, build = {}, power = own.power, hasBuffies = true) {
  const sp = own.starPowers?.map((x) => x.id ?? x) || [];
  const gad = own.gadgets?.map((x) => x.id ?? x) || [];
  const gears = own.gears?.length || 0;
  const buffies = hasBuffies && own.buffies ? 3 - ['gadget', 'starPower', 'hyperCharge'].filter((k) => own.buffies[k]).length : 0;
  return [
    Math.max(0, Math.min(2, 11 - power)),
    own.hyperCharges?.length ? 0 : 1,
    buffies,
    sp.length ? 0 : 1,
    sp.length && build.sp?.[3] && !sp.includes(build.sp[0]) ? 1 : 0, // owns only other star power(s)
    gad.length ? 0 : 1,
    gad.length && build.gad?.[3] && !gad.includes(build.gad[0]) ? 1 : 0,
    Math.max(0, 2 - gears),
  ];
}

// Ranked games only. In trophy games you're matched by that brawler's trophies, so a less built-up
// brawler (fewer trophies) faces easier opponents and looks *better*: measured on trophy games,
// "below power 11" came out +8.5 points. Ranked matches by the player's rank instead.
const GAME_TYPES = new Set(['soloRanked', 'teamRanked']);
// buffy: Set of brawler ids that have buffies (others never count as missing them).
export function tallyEffects(profiles, logsByTag, builds = {}, acc = blankEffects(), buffy = new Set()) {
  for (const pr of profiles) {
    const log = pr?.tag && logsByTag.get(pr.tag);
    if (!log) continue;
    const owned = new Map((pr.brawlers || []).map((b) => [b.id, b]));
    const rows = [];
    for (const it of Array.isArray(log) ? log : log.items || []) {
      const bt = it?.battle || {};
      if (!GAME_TYPES.has(bt.type) || !Array.isArray(bt.teams)) continue;
      if (bt.result !== 'victory' && bt.result !== 'defeat') continue;
      const me = bt.teams.flat().find((p) => p?.tag === pr.tag);
      const own = me && owned.get(me.brawler?.id);
      const power = me?.brawler?.power;
      if (!own || !(power >= 9)) continue;
      rows.push({ x: featuresFor(own, builds[own.id], power, buffy.has(own.id)), y: bt.result === 'victory' ? 1 : 0 });
    }
    if (rows.length < 2) continue;
    const mx = Array(K).fill(0);
    let my = 0;
    for (const r of rows) { for (let k = 0; k < K; k++) mx[k] += r.x[k] / rows.length; my += r.y / rows.length; }
    acc.players++;
    for (const r of rows) {
      acc.n++;
      const d = r.x.map((v, k) => v - mx[k]);
      for (let i = 0; i < K; i++) {
        if (r.x[i]) acc.nz[i]++;
        acc.xty[i] += d[i] * (r.y - my);
        for (let j = 0; j < K; j++) acc.xtx[i * K + j] += d[i] * d[j];
      }
    }
  }
  return acc;
}

export function addEffects(into, from) {
  if (!from || from.v !== 3) return into; // older sums were biased (v1: trophy games; v2: buffies counted for every brawler)
  into.n += from.n; into.players += from.players;
  for (let i = 0; i < K; i++) { into.nz[i] += from.nz[i]; into.xty[i] += from.xty[i]; }
  for (let i = 0; i < K * K; i++) into.xtx[i] += from.xtx[i];
  return into;
}

// Solve (X'X + ridge) b = X'y. Returns per piece: effect on win rate (points), its standard error,
// and the penalty used: the cautious end of the estimate (effect + 1 SE, never below 0), so noisy
// pieces cost little. Pieces seen in fewer than 30 games get no penalty.
export function solveEffects(acc, ridge = 20) {
  const A = acc.xtx.map((v, i) => v + (i % (K + 1) === 0 ? ridge : 0));
  const inv = invert(A, K);
  const beta = Array.from({ length: K }, (_, i) => inv.slice(i * K, i * K + K).reduce((s, v, j) => s + v * acc.xty[j], 0));
  const out = { n: acc.n, players: acc.players, pieces: {} };
  EFFECTS.forEach((name, i) => {
    const se = Math.sqrt(0.25 * Math.max(0, inv[i * K + i]));
    const effect = 100 * beta[i], seP = 100 * se;
    const penalty = acc.nz[i] >= 30 ? Math.max(0, -(effect + seP)) : 0;
    out.pieces[name] = { effect: round1(effect), se: round1(seP), penalty: round1(penalty), games: acc.nz[i] };
  });
  return out;
}
const round1 = (x) => Math.round(x * 10) / 10;

function invert(A, n) {
  const M = A.map((v) => v), I = Array.from({ length: n * n }, (_, i) => (i % (n + 1) === 0 ? 1 : 0));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
    for (let k = 0; k < n; k++) { [M[c * n + k], M[p * n + k]] = [M[p * n + k], M[c * n + k]]; [I[c * n + k], I[p * n + k]] = [I[p * n + k], I[c * n + k]]; }
    const d = M[c * n + c] || 1e-12;
    for (let k = 0; k < n; k++) { M[c * n + k] /= d; I[c * n + k] /= d; }
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r * n + c];
      if (!f) continue;
      for (let k = 0; k < n; k++) { M[r * n + k] -= f * M[c * n + k]; I[r * n + k] -= f * I[c * n + k]; }
    }
  }
  return I;
}
