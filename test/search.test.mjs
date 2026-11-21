import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initials, searchMaps, matchScore } from '../site/search.js';

const maps = [
  { name: 'Hard Rock Mine', ranked: true },
  { name: 'Hot Potato', ranked: true },
  { name: 'Hideout', ranked: true },
  { name: "Belle's Rock", ranked: true },
  { name: 'Bridge Too Far', ranked: true },
  { name: 'Hard Lane', ranked: false },
  { name: 'Out in the Open', ranked: true },
  { name: 'Ring of Fire', ranked: false },
];
const names = (q) => searchMaps(q, maps).map((m) => m.name);

test('initials', () => {
  assert.equal(initials('Hard Rock Mine'), 'hrm');
  assert.equal(initials("Belle's Rock"), 'br');
  assert.equal(initials('Out in the Open'), 'oito');
});

test('exact initials win', () => {
  assert.equal(names('hrm')[0], 'Hard Rock Mine');
  assert.equal(names('HP')[0], 'Hot Potato');
  assert.equal(names('btf')[0], 'Bridge Too Far');
  assert.equal(names('oito')[0], 'Out in the Open');
});

test('ranked first within a tier', () => {
  assert.equal(names('hr')[0], 'Hard Rock Mine');
  assert.notEqual(names('h')[0], 'Hard Lane');
});

test('exact beats ranked prefix', () => {
  assert.equal(names('rof')[0], 'Ring of Fire');
});

test('name prefix and substring', () => {
  assert.equal(names('hide')[0], 'Hideout');
  assert.equal(names('rock mi')[0], 'Hard Rock Mine');
  assert.ok(names('potato').includes('Hot Potato'));
  assert.equal(matchScore('zzz', 'Hot Potato'), null);
});

import { searchBrawlers } from '../site/search.js';
const BR = [{ id: 1, name: 'Belle' }, { id: 2, name: 'Bea' }, { id: 3, name: 'Mr. P' }, { id: 4, name: '8-Bit' }, { id: 5, name: 'El Primo' }, { id: 6, name: 'Shelly' }, { id: 7, name: 'Barley' }];
test('brawler search: name prefixes, punctuation ignored', () => {
  assert.deepEqual(searchBrawlers('be', BR).map((b) => b.name), ['Bea', 'Belle']);
  assert.deepEqual(searchBrawlers('mr p', BR).map((b) => b.name), ['Mr. P']);
  assert.deepEqual(searchBrawlers('8bit', BR).map((b) => b.name), ['8-Bit']);
  assert.deepEqual(searchBrawlers('primo', BR).map((b) => b.name), ['El Primo']);
  assert.deepEqual(searchBrawlers('ell', BR).map((b) => b.name), ['Belle', 'Shelly']); // substring from 3 letters
});
test('brawler search: map initials and single letters stay quiet', () => {
  assert.deepEqual(searchBrawlers('hrm', BR), []);
  assert.deepEqual(searchBrawlers('', BR), []);
  assert.deepEqual(searchBrawlers('b', BR).map((b) => b.name), ['Barley', 'Bea', 'Belle', '8-Bit']); // names first, then words (8-Bit)
});
