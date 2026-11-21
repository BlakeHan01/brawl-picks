import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readiness, curate, normalizeTag, PENALTY } from '../site/curate.js';

const full = (id, extra = {}) => ({ id, power: 11, starPowers: [1], gadgets: [2], gears: [3, 4], hyperCharges: [5], buffies: { gadget: true, starPower: true, hyperCharge: true }, ...extra });

test('a fully built brawler has nothing missing', () => {
  assert.deepEqual(readiness(full(1), { sp: [1, 70, 100, 1], gad: [2, 80, 100, 1] }), { missing: [], penalty: 0 });
});

test('missing pieces are listed and cost points', () => {
  const r = readiness({ id: 1, power: 10, starPowers: [9], gadgets: [], gears: [3], hyperCharges: [], buffies: { gadget: true, starPower: false, hyperCharge: false } }, { sp: [1, 70, 100, 1] });
  assert.deepEqual(r.missing, ['Power 10', 'Not the top star power', 'No gadget', '1 gear missing', 'No hypercharge', 'Buffies 1/3']);
  assert.equal(r.penalty, Math.round((2.5 + 1 + 1.5 + 0.75 + 1.5 + 0.8) * 10) / 10);
});

test('a close-call star power is not held against the player', () => {
  assert.deepEqual(readiness(full(1, { starPowers: [9] }), { sp: [1, 52, 100, 0] }).missing, []);
});

test('curate: owned only, power 9+, built brawlers can overtake slightly stronger unbuilt ones', () => {
  const rows = [[10, 56, 55, 10, 100, 5], [20, 55, 54, 10, 100, 5], [30, 54, 53, 10, 100, 5], [40, 53, 52, 10, 100, 5], [50, 60, 59, 10, 100, 5]];
  const profile = { brawlers: [
    full(10, { hyperCharges: [], buffies: { gadget: false, starPower: false, hyperCharge: false } }), // 56 - 1.5 - 1.2 = 53.3
    full(20), // 55
    full(30, { power: 8 }), // too low: left out
    full(40), // 53
  ] }; // 50 not owned
  const c = curate(rows, profile, {});
  assert.deepEqual(c.map((x) => x.row[0]), [20, 10, 40]);
  assert.equal(c[1].curated, 53.3);
  assert.deepEqual(c[1].missing, ['No hypercharge', 'Buffies 0/3']);
  assert.ok(PENALTY.noHypercharge > 0);
});

test('tag normalization', () => {
  assert.equal(normalizeTag('#2ppoy8lq'), '2PP0Y8LQ');
  assert.equal(normalizeTag('abc'), null);
});
