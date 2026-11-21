// Worker tests: plain Node, fake upstream (no network, no Cloudflare account needed).
//   node --test worker/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { normalizeTag, parseTime, shapePlayer, shapeRotation, dispatchStats } from '../src/index.js';

const env = { BS_API_KEY: 'KEY', GH_TOKEN: 'GHT', GH_REPO: 'o/r', BS_API_BASE: 'https://up.test/v1', ALLOWED_ORIGINS: 'https://blakehan01.github.io,http://localhost:5173' };
const ctx = { waitUntil() {} };
const calls = [];
function fakeFetch(routes) {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [re, fn] of routes) { const m = String(url).match(re); if (m) return fn(m, init); }
    return new Response('{}', { status: 404 });
  };
}
const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const get = (path, origin = 'https://blakehan01.github.io') => worker.fetch(new Request(`https://w.test${path}`, { headers: origin ? { Origin: origin } : {} }), env, ctx);

const PROFILE = {
  tag: '#2PP0Y8LQ', name: 'Me', trophies: 50000, club: { tag: '#CLUB' }, icon: { id: 1 },
  brawlers: [{
    id: 16000000, name: 'SHELLY', power: 11, rank: 25, trophies: 1200, skin: { id: 1, name: 'X' },
    starPowers: [{ id: 23000076, name: 'SHELL SHOCK' }], gadgets: [{ id: 23000255, name: 'FAST FORWARD' }, { id: 23000288, name: 'CLAY PIGEONS' }],
    gears: [{ id: 62000002, name: 'DAMAGE', level: 3 }], hyperCharges: [{ id: 23000613, name: 'DOUBLE BARREL' }],
    buffies: { gadget: true, starPower: false, hyperCharge: true },
  }],
};
const ROTATION = [
  { slotId: 2, startTime: '20261120T080000.000Z', endTime: '20261121T080000.000Z', event: { id: 15000007, mode: 'gemGrab', map: 'Hard Rock Mine' } },
  { slotId: 1, startTime: '20261120T060000.000Z', endTime: '20261121T060000.000Z', event: { id: 15000853, mode: 'airHockey', map: 'Below Zero', modifiers: ['x'] } },
  { slotId: 3, endTime: 'bad', event: { map: 'Broken' } },
];

test('tag normalization', () => {
  assert.equal(normalizeTag('#2pp0y8lq'), '2PP0Y8LQ');
  assert.equal(normalizeTag('%232PPOY8LQ'), '2PP0Y8LQ'); // URL-encoded #, letter O -> 0
  assert.equal(normalizeTag('abc!'), null);
  assert.equal(normalizeTag('XX'), null);
  assert.equal(normalizeTag(''), null);
});

test('time conversion', () => {
  assert.equal(parseTime('20261120T080000.000Z'), '2026-11-20T08:00:00.000Z');
  assert.equal(parseTime('nope'), null);
});

test('player shape keeps ids only, drops club/skins/names', () => {
  const p = shapePlayer(PROFILE, new Date('2026-11-21T00:00:00Z'));
  assert.deepEqual(p, {
    tag: '#2PP0Y8LQ', name: 'Me', trophies: 50000, fetchedAt: '2026-11-21T00:00:00.000Z',
    brawlers: [{ id: 16000000, power: 11, trophies: 1200, rank: 25, starPowers: [23000076], gadgets: [23000255, 23000288], gears: [62000002], hyperCharges: [23000613], buffies: { gadget: true, starPower: false, hyperCharge: true } }],
  });
  assert.equal(shapePlayer({ brawlers: [{ id: 1 }] }).brawlers[0].buffies, undefined);
});

test('rotation shape: ISO times, sorted by slot, broken events dropped', () => {
  const r = shapeRotation(ROTATION);
  assert.equal(r.events.length, 2);
  assert.equal(r.events[0].map, 'Below Zero');
  assert.deepEqual(r.events[1], { slot: 2, id: 15000007, map: 'Hard Rock Mine', modeId: 'gemGrab', start: '2026-11-20T08:00:00.000Z', end: '2026-11-21T08:00:00.000Z', modifiers: [] });
});

test('GET /player/:tag calls upstream with the key and returns the shape with CORS', async () => {
  calls.length = 0;
  fakeFetch([[/\/players\/%232PP0Y8LQ$/, () => ok(PROFILE)]]);
  const res = await get('/player/%232ppoy8lq');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://blakehan01.github.io');
  assert.match(res.headers.get('Cache-Control'), /max-age=60/);
  const body = await res.json();
  assert.equal(body.brawlers[0].gadgets.length, 2);
  assert.equal(body.club, undefined);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer KEY');
});

test('player errors: bad tag, unknown player, key problem, busy', async () => {
  fakeFetch([
    [/%23999$/, () => new Response('{}', { status: 404 })],
    [/%23888$/, () => new Response('{}', { status: 403 })],
    [/%23222$/, () => new Response('{}', { status: 429 })],
  ]);
  assert.equal((await get('/player/abc!')).status, 400);
  assert.deepEqual(await (await get('/player/999')).json(), { error: 'not_found' });
  assert.equal((await get('/player/888')).status, 502);
  const busy = await get('/player/222');
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('Retry-After'), '30');
});

test('GET /rotation and CORS rules', async () => {
  fakeFetch([[/\/events\/rotation$/, () => ok(ROTATION)]]);
  const res = await get('/rotation', 'http://localhost:5173');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5173');
  assert.match(res.headers.get('Cache-Control'), /max-age=120/);
  assert.equal((await res.json()).events.length, 2);
  const other = await get('/rotation', 'https://evil.test');
  assert.equal(other.headers.get('Access-Control-Allow-Origin'), null); // other sites can't read it
  const pre = await worker.fetch(new Request('https://w.test/rotation', { method: 'OPTIONS', headers: { Origin: 'https://blakehan01.github.io' } }), env, ctx);
  assert.equal(pre.status, 204);
  assert.equal((await get('/nope')).status, 404);
  assert.equal((await worker.fetch(new Request('https://w.test/rotation', { method: 'POST' }), env, ctx)).status, 405);
});

test('cron dispatches the stats workflow on main', async () => {
  calls.length = 0;
  fakeFetch([[/api\.github\.com\/repos\/o\/r\/actions\/workflows\/daily\.yml\/dispatches$/, () => new Response(null, { status: 204 })]]);
  assert.equal(await dispatchStats(env), 204);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer GHT');
  assert.deepEqual(JSON.parse(calls[0].init.body), { ref: 'main', inputs: { stats: 'true' } });
});
