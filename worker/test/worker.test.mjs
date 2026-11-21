// Tests for the Cloudflare Worker. No dependencies, no network:
// upstream fetch (and the Cache API, where needed) is stubbed.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  normalizeTag,
  isValidTag,
  parseBrawlTime,
  shapePlayer,
  shapeRotation,
  handleFetch,
  handleScheduled,
  GH_DISPATCH_URL,
} from '../src/index.js';

const ENV = { BS_API_KEY: 'test-key', GH_TOKEN: 'test-gh-token' };
const ORIGIN = 'https://blakehan01.github.io';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete globalThis.caches;
});

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  };
  return calls;
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const req = (path, { method = 'GET', origin = ORIGIN } = {}) =>
  new Request(`https://brawl-picks-api.test${path}`, { method, headers: origin ? { Origin: origin } : {} });

// --- tag normalization ---

test('normalizeTag: strips #, uppercases, O -> 0', () => {
  assert.equal(normalizeTag('#p2l'), 'P2L');
  assert.equal(normalizeTag('2ppoo'), '2PP00');
  assert.equal(normalizeTag('ABC123'), 'ABC123');
  assert.equal(normalizeTag(''), '');
});

test('isValidTag: Brawl Stars alphabet, 3-12 chars', () => {
  assert.equal(isValidTag('P2L'), true);
  assert.equal(isValidTag('2PP00'), true);
  assert.equal(isValidTag('AB'), false); // too short
  assert.equal(isValidTag('ABC!'), false);
  assert.equal(isValidTag('ABC1'), false); // 1 is not in the alphabet
  assert.equal(isValidTag('ABCDEFGHIJKLM'), false); // too long
});

// --- rotation time conversion ---

test('parseBrawlTime reads the API time format', () => {
  assert.equal(parseBrawlTime('20261120T080000.000Z'), Date.UTC(2026, 10, 20, 8, 0, 0));
  assert.equal(parseBrawlTime('2026-11-20T08:00:00.000Z'), Date.UTC(2026, 10, 20, 8, 0, 0));
  assert.ok(Number.isNaN(parseBrawlTime(null)));
  assert.ok(Number.isNaN(parseBrawlTime('')));
});

// --- shaping ---

test('shapePlayer returns only brawler data, ids only, buffies passthrough', () => {
  const out = shapePlayer(
    {
      tag: '#p2l',
      name: 'PlayerName',
      trophies: 52341,
      club: { tag: '#CLUB', name: 'Club' },
      icon: { id: 28000000 },
      brawlers: [
        {
          id: 16000000, power: 11, trophies: 1200, rank: 25,
          starPowers: [{ id: 23000076, name: 'SP' }, { id: 23000135, name: 'SP2' }],
          gadgets: [{ id: 23000255, name: 'G' }],
          gears: [{ id: 62000002, name: 'Gear' }, { id: 62000004, name: 'Gear2' }],
          hyperCharges: [{ id: 23000613, name: 'HC' }],
          buffies: { gadget: true, starPower: false, hyperCharge: false },
        },
        { id: 16000001, power: 9, trophies: 500, rank: 20, starPowers: [], gadgets: [] },
      ],
    },
    '2026-11-20T22:00:00.000Z',
  );
  assert.equal(out.tag, '#P2L');
  assert.equal(out.name, 'PlayerName');
  assert.equal(out.trophies, 52341);
  assert.equal(out.fetchedAt, '2026-11-20T22:00:00.000Z');
  assert.equal(out.club, undefined);
  assert.equal(out.icon, undefined);
  assert.deepEqual(out.brawlers[0].starPowers, [23000076, 23000135]);
  assert.deepEqual(out.brawlers[0].gadgets, [23000255]);
  assert.deepEqual(out.brawlers[0].gears, [62000002, 62000004]);
  assert.deepEqual(out.brawlers[0].hyperCharges, [23000613]);
  assert.deepEqual(out.brawlers[0].buffies, { gadget: true, starPower: false, hyperCharge: false });
  assert.deepEqual(out.brawlers[1].starPowers, []);
  assert.equal('buffies' in out.brawlers[1], false);
});

test('shapeRotation converts times, drops mapless/endless events, sorts by slot', () => {
  const out = shapeRotation(
    {
      items: [
        { slotId: 2, startTime: '20261120T080000.000Z', endTime: '20261121T080000.000Z',
          event: { id: 15000008, map: 'Second Map', mode: 'brawlBall', modifiers: ['m1'] } },
        { slotId: 1, startTime: '20261120T080000.000Z', endTime: '20261121T080000.000Z',
          event: { id: 15000007, map: 'Hard Rock Mine', mode: 'gemGrab' } },
        { slotId: 3, startTime: '20261120T080000.000Z', endTime: '20261121T080000.000Z',
          event: { id: 15000009, mode: 'heist' } }, // no map: dropped
        { slotId: 4, startTime: '20261120T080000.000Z', endTime: null,
          event: { id: 15000010, map: 'No End', mode: 'heist' } }, // no end: dropped
      ],
    },
    '2026-11-20T22:00:00.000Z',
  );
  assert.equal(out.fetchedAt, '2026-11-20T22:00:00.000Z');
  assert.equal(out.events.length, 2);
  assert.deepEqual(out.events[0], {
    slot: 1, id: 15000007, map: 'Hard Rock Mine', modeId: 'gemGrab', modifiers: [],
    start: '2026-11-20T08:00:00.000Z', end: '2026-11-21T08:00:00.000Z',
  });
  assert.deepEqual(out.events[1].modifiers, ['m1']);
  assert.equal(out.events[0].mode, undefined); // display fields are the site's job
});

// --- HTTP: player ---

test('GET /player/:tag returns shaped brawlers, CORS, max-age=60', async () => {
  const calls = mockFetch(() =>
    json({ tag: '#P2L', name: 'PlayerName', trophies: 100, brawlers: [{ id: 16000000, power: 11, trophies: 1, rank: 1, starPowers: [{ id: 1 }] }] }),
  );
  const res = await handleFetch(req('/player/%23p2l'), ENV);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const body = await res.json();
  assert.equal(body.tag, '#P2L');
  assert.equal(body.brawlers[0].starPowers[0], 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://bsproxy.royaleapi.dev/v1/players/%23P2L');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
});

test('GET /player/abc! returns 400 bad_tag without calling upstream', async () => {
  const calls = mockFetch(() => json({}));
  const res = await handleFetch(req('/player/abc!'), ENV);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'bad_tag' });
  assert.equal(calls.length, 0);
});

test('player upstream errors map to not_found / upstream_auth / busy', async () => {
  for (const [upstreamStatus, wantStatus, wantError, wantRetry] of [
    [404, 404, 'not_found', null],
    [403, 502, 'upstream_auth', null],
    [429, 503, 'busy', '30'],
    [500, 502, 'upstream', null],
  ]) {
    mockFetch(() => json({ message: 'x' }, upstreamStatus));
    const res = await handleFetch(req('/player/P2L'), ENV);
    assert.equal(res.status, wantStatus, `upstream ${upstreamStatus}`);
    assert.deepEqual(await res.json(), { error: wantError });
    assert.equal(res.headers.get('Retry-After'), wantRetry);
  }
});

// --- HTTP: rotation ---

test('GET /rotation returns shaped events, max-age=120', async () => {
  mockFetch(() =>
    json({ items: [{ slotId: 1, startTime: '20261120T080000.000Z', endTime: '20261121T080000.000Z',
      event: { id: 15000007, map: 'Hard Rock Mine', mode: 'gemGrab', modifiers: [] } }] }),
  );
  const res = await handleFetch(req('/rotation'), ENV);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=120');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const body = await res.json();
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].map, 'Hard Rock Mine');
  assert.equal(body.events[0].end, '2026-11-21T08:00:00.000Z');
  assert.ok(Date.parse(body.fetchedAt) <= Date.now());
});

// --- HTTP: common ---

test('unknown path returns 404, disallowed origin is not reflected, OPTIONS preflights', async () => {
  const res = await handleFetch(req('/nope'), ENV);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });

  mockFetch(() => json({ items: [] }));
  const evil = await handleFetch(req('/rotation', { origin: 'https://evil.example' }), ENV);
  assert.equal(evil.status, 200);
  assert.equal(evil.headers.get('Access-Control-Allow-Origin'), null);

  const pre = await handleFetch(req('/rotation', { method: 'OPTIONS' }), ENV);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(pre.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');

  const post = await handleFetch(req('/rotation', { method: 'POST' }), ENV);
  assert.equal(post.status, 405);
});

test('player responses are cached 60s via the Cache API', async () => {
  const store = new Map();
  globalThis.caches = {
    default: {
      match: async (key) => store.get(key.url),
      put: async (key, res) => { store.set(key.url, res); },
      delete: async (key) => { store.delete(key.url); },
    },
  };
  let upstreamCalls = 0;
  mockFetch(() => {
    upstreamCalls++;
    return json({ tag: '#P2L', name: 'N', trophies: 1, brawlers: [] });
  });
  const first = await handleFetch(req('/player/P2L'), ENV);
  assert.equal(first.status, 200);
  const second = await handleFetch(req('/player/P2L'), ENV);
  assert.equal(second.status, 200);
  assert.equal(upstreamCalls, 1, 'second call served from cache');
  assert.equal((await second.json()).tag, '#P2L');
});

// --- cron ---

test('scheduled() dispatches daily.yml with stats=true and expects 204', async () => {
  const calls = mockFetch(() => new Response(null, { status: 204 }));
  assert.equal(await handleScheduled(ENV), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, GH_DISPATCH_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-gh-token');
  assert.equal(calls[0].init.headers.Accept, 'application/vnd.github+json');
  assert.equal(calls[0].init.headers['User-Agent'], 'brawl-picks-worker');
  assert.deepEqual(JSON.parse(calls[0].init.body), { ref: 'main', inputs: { stats: 'true' } });

  mockFetch(() => new Response(null, { status: 403 }));
  assert.equal(await handleScheduled(ENV), false);

  assert.equal(await handleScheduled({}), false, 'no GH_TOKEN: skip, do not throw');
});

test('default export exposes fetch and scheduled', () => {
  assert.equal(typeof worker.fetch, 'function');
  assert.equal(typeof worker.scheduled, 'function');
});
