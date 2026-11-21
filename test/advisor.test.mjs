import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEVEL, upgradeSteps, upgradeChains, makePlan, saveUpFor, bestPackage } from '../site/advisor.js';
import { PENALTY } from '../site/curate.js';

const full = (id, extra = {}) => ({ id, power: 11, starPowers: [1], gadgets: [2], gears: [3, 4], hyperCharges: [5], buffies: { gadget: true, starPower: true, hyperCharge: true }, ...extra });

test('level prices add up to the in-game total (7,765 coins, 3,740 power points)', () => {
  const v = Object.values(LEVEL);
  assert.equal(v.reduce((s, x) => s + x[0], 0), 7765);
  assert.equal(v.reduce((s, x) => s + x[1], 0), 3740);
});

test('a maxed brawler has nothing left to buy', () => {
  assert.deepEqual(upgradeSteps(full(1)), []);
});

test('steps come in buying order with the right prices and named items', () => {
  const own = { id: 1, power: 7, starPowers: [], gadgets: [], gears: [], hyperCharges: [], buffies: { gadget: false, starPower: false, hyperCharge: false } };
  const build = { sp: [11, 70, 100, 1], gad: [12, 60, 100, 1], gear: [[13, 14], 40, 100, 1] };
  const s = upgradeSteps(own, build, { 11: 'Spark', 12: 'Pop', 13: 'Shield', 14: 'Damage' });
  assert.deepEqual(s.map((x) => [x.kind, x.label, x.coins, x.pp]), [
    ['power', 'Power 7 → 9', 2050, 890],
    ['gadget', 'Pop', 1000, 0],
    ['starPower', 'Spark', 2000, 0],
    ['power', 'Power 9 → 10', 1875, 890],
    ['power', 'Power 10 → 11', 2800, 1440],
    ['gear', 'Shield', 1000, 0],
    ['gear', 'Damage', 1000, 0],
    ['hypercharge', 'Hypercharge', 5000, 0],
    ['buffie', 'Buffie', 2500, 5000], // 3 missing + 6 others left in the machine: 2.5 pulls each on average
    ['buffie', 'Buffie', 2500, 5000],
    ['buffie', 'Buffie', 2500, 5000],
  ]);
  assert.equal(s.at(-1).own.power, 11);
});

test('owning only the other star power counts when skilled players clearly prefer one', () => {
  const own = full(1, { starPowers: [9] });
  assert.deepEqual(upgradeSteps(own, { sp: [11, 70, 100, 1] }).map((x) => x.kind), ['starPower']);
  assert.deepEqual(upgradeSteps(own, { sp: [11, 52, 100, 0] }), []); // close call: either is fine
});

// Two maps. Brawler 30 is the best on both but sits at power 8 (can't be picked yet).
const maps = [{ rows: [[30, 70], [10, 52], [20, 51], [40, 50]] }, { rows: [[30, 68], [20, 53], [10, 50], [40, 49]] }];
const profile = { brawlers: [full(10), full(20), full(40), { id: 30, power: 8, starPowers: [], gadgets: [1], gears: [3, 4], hyperCharges: [], buffies: { gadget: false, starPower: false, hyperCharge: false } }] };

test('upgrading a strong brawler that is not usable yet is worth the most', () => {
  const { strength, chains } = upgradeChains(profile, maps, {}, PENALTY);
  assert.equal(Math.round(strength * 100) / 100, 50.83); // (52+51+50)/3 and (53+50+49)/3
  assert.deepEqual(Object.keys(chains), ['30']); // the others are maxed
  const first = chains[30][0];
  assert.equal(first.label, 'Power 8 → 9');
  assert.ok(first.gain > 0);
  assert.deepEqual(first.top.map((x) => x[0]), [0, 1]); // joins your top 3 on both maps
});

test('plan stays within budget, picks the best value first, and says what to save for', () => {
  const { chains } = upgradeChains(profile, maps, {}, PENALTY);
  const none = makePlan(chains, 500, 100);
  assert.equal(none.list.length, 0);
  const p = makePlan(chains, 3000, 1000);
  assert.ok(p.list.length >= 1 && p.coinsLeft >= 0 && p.ppLeft >= 0);
  assert.equal(p.list[0].id, '30');
  assert.equal(p.list[0].from, 0);
  const later = saveUpFor(chains, p);
  for (const b of later) assert.ok(b.coins > p.coinsLeft || b.pp > p.ppLeft);
});

test('a package only covers steps in order and never skips one', () => {
  const chain = [{ coins: 1000, pp: 0, gain: 0 }, { coins: 1000, pp: 0, gain: 2 }, { coins: 5000, pp: 0, gain: 0.1 }];
  assert.deepEqual([bestPackage(chain).from, bestPackage(chain).to], [0, 1]);
  assert.equal(bestPackage(chain, 0, 1500), null); // the first step alone gains nothing
});

import { pullsPerBuffie } from '../site/advisor.js';
test('claw machine: expected pulls per wanted buffie (random order, no duplicates)', () => {
  assert.equal(pullsPerBuffie(3, 6), 2.5); // 9 left, want 3 -> every 2.5 pulls
  assert.equal(pullsPerBuffie(1, 6), 4); // 7 left, want the last one -> 4 pulls on average
  assert.equal(pullsPerBuffie(1, 0), 1); // only one left: the next pull
  // brute force check of (R+1)/(m+1): average position of the first wanted item in a shuffle
  const R = 9, m = 3; let sum = 0, n = 0;
  const perm = (a) => a.length ? a.flatMap((x, i) => perm([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])) : [[]];
  for (const p of perm([...Array(R).keys()].slice(0, 7))) { sum += p.findIndex((x) => x < m) + 1; n++; } // 7 items, 3 wanted
  assert.ok(Math.abs(sum / n - (7 + 1) / (3 + 1)) < 1e-9);
});
