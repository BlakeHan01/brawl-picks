import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readiness, curate, normalizeTag, PENALTY, costsFrom } from '../site/curate.js';

const full = (id, extra = {}) => ({ id, power: 11, starPowers: [1], gadgets: [2], gears: [3, 4], hyperCharges: [5], buffies: { gadget: true, starPower: true, hyperCharge: true }, ...extra });

test('a fully built brawler has nothing missing', () => {
  assert.deepEqual(readiness(full(1), { sp: [1, 70, 100, 1], gad: [2, 80, 100, 1] }), { missing: [], penalty: 0 });
});

test('missing pieces are listed and cost points', () => {
  const r = readiness({ id: 1, power: 10, starPowers: [9], gadgets: [], gears: [3], hyperCharges: [], buffies: { gadget: true, starPower: false, hyperCharge: false } }, { sp: [1, 70, 100, 1] });
  assert.deepEqual(r.missing, ['Power 10', 'Not the top star power', 'No gadget', '1 gear missing', 'No hypercharge', 'Buffies 1/3']);
  assert.equal(r.penalty, Math.round((2.5 + 1 + 1.5 + 0.75 + 1.5 + 3) * 10) / 10);
});

test('a close-call star power is not held against the player', () => {
  assert.deepEqual(readiness(full(1, { starPowers: [9] }), { sp: [1, 52, 100, 0] }).missing, []);
});

test('curate: score minus build costs; a strong power 11 brawler missing one piece can still lead', () => {
  const rows = [[10, 60, 59, 10, 100, 5], [20, 55, 54, 10, 100, 5], [30, 58, 57, 10, 100, 5], [40, 53, 52, 10, 100, 5], [50, 57, 56, 10, 100, 5]];
  const P = costsFrom({ n: 50000, pieces: { noHypercharge: { penalty: 2 }, powerLevel: { penalty: 4 } } });
  assert.equal(costsFrom({ n: 100, pieces: { powerLevel: { penalty: 0 } } }).powerLevel, PENALTY.powerLevel); // too few games: fallback
  const profile = { brawlers: [
    full(10, { hyperCharges: [] }), // 60 - 2 = 58
    full(20), // 55
    full(30, { power: 10 }), // 58 - 4 = 54
    full(40), // 53
    full(50, { power: 8 }), // below 9: left out
  ] };
  const c = curate(rows, profile, {}, P);
  assert.deepEqual(c.map((x) => x.row[0]), [10, 20, 30, 40]);
  assert.equal(c[0].curated, 58);
  assert.deepEqual(c[0].missing, ['No hypercharge']);
  assert.equal(P.noGadget, PENALTY.noGadget); // not measured: fallback
});

test('tag normalization', () => {
  assert.equal(normalizeTag('#2ppoy8lq'), '2PP0Y8LQ');
  assert.equal(normalizeTag('abc'), null);
});

import { withRealBuffies } from '../site/curate.js';
import { tallyBuilds, buffyBrawlers, featuresFor } from '../scripts/builds.mjs';

test('buffies only count for brawlers that have them in the game', () => {
  const piper = full(15, { buffies: { gadget: false, starPower: false, hyperCharge: false } });
  const colt = full(1, { buffies: { gadget: true, starPower: false, hyperCharge: false } });
  const p = withRealBuffies({ brawlers: [piper, colt] }, [1]);
  assert.deepEqual(readiness(p.brawlers[0]).missing, []); // Piper: no buffies exist, nothing missing
  assert.deepEqual(readiness(p.brawlers[1]).missing, ['Buffies 1/3']);
  assert.equal(withRealBuffies({ brawlers: [colt] }, undefined).brawlers[0].buffies, undefined); // no list yet: ignore buffies
});

test('which brawlers have buffies: owned by at least 3 skilled players', () => {
  const pr = (own) => ({ brawlers: [{ id: 1, power: 11, buffies: { gadget: own, starPower: false, hyperCharge: false } }, { id: 15, power: 11, buffies: { gadget: false, starPower: false, hyperCharge: false } }] });
  const day = tallyBuilds([pr(true), pr(true), pr(false)]);
  assert.deepEqual(buffyBrawlers([day]), []); // 2 owners: not enough yet
  assert.deepEqual(buffyBrawlers([day, tallyBuilds([pr(true)])]), [1]);
  const piper = { power: 11, starPowers: [1], gadgets: [2], gears: [3, 4], hyperCharges: [5], buffies: { gadget: false, starPower: false, hyperCharge: false } };
  assert.equal(featuresFor(piper, {}, 11, false)[2], 0); // build-cost model: no "missing buffies" for Piper
  assert.equal(featuresFor(piper, {}, 11, true)[2], 3);
});

test('owning two gears that are not the top pair counts as missing (when the pair is clear)', () => {
  const g = { gear: [[7, 8], 60, 100, 1] };
  assert.deepEqual(readiness(full(1, { gears: [3, 4] }), g).missing, ['Not the top gears']);
  assert.deepEqual(readiness(full(1, { gears: [3, 7, 8] }), g).missing, []);
  assert.deepEqual(readiness(full(1, { gears: [3, 4] }), { gear: [[7, 8], 30, 100, 0] }).missing, []); // not clear
});
