// Data pipeline: filters, windowing and an end-to-end run against a mock official API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tally, buildMaps, crawlTags, rankBrawlers } from '../scripts/fetch-data.mjs';
import { parseRotation } from '../scripts/fetch-rotation.mjs';
import { parseTime, modeName } from '../scripts/lib.mjs';

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '.000Z');

// One battle from `tag`'s point of view. brawlers: 6 ids (first 3 are tag's team).
function battle(tag, i, { map = 'Hard Rock Mine', id = 15000007, mode = 'gemGrab', type = 'soloRanked', trophies = 900, win = true, brawlers, size = 3, t = T0 - i * 60000 } = {}) {
  const ids = brawlers || Array.from({ length: size * 2 }, (_, k) => 16000000 + k);
  const team = (o) => ids.slice(o, o + size).map((b, k) => ({ tag: o === 0 && k === 0 ? tag : `#${tag.slice(1)}${i}x${o + k}`, brawler: { id: b, trophies } }));
  return { battleTime: stamp(t), event: { id, mode, map }, battle: { mode, type, result: win ? 'victory' : 'defeat', teams: [team(0), team(size)] } };
}

test('parseTime reads the API time format', () => {
  assert.equal(parseTime('20261120T080000.000Z'), Date.UTC(2026, 10, 20, 8, 0, 0));
  assert.equal(parseTime('2026-11-20T08:00:00Z'), Date.UTC(2026, 10, 20, 8, 0, 0));
  assert.ok(Number.isNaN(parseTime(null)));
});

test('mode names: known and unknown ids', () => {
  assert.equal(modeName('brawlHockey'), 'Brawl Hockey');
  assert.equal(modeName('knockout5V5'), 'Knockout 5v5');
  assert.equal(modeName('someNewMode'), 'Some New Mode');
});

test('tally keeps ranked + high-trophy games and drops the rest', () => {
  const logs = [{ items: [
    battle('#P1', 0),                                                   // ranked: kept
    battle('#P1', 1, { type: 'teamRanked' }),                           // ranked: kept
    battle('#P1', 2, { type: 'ranked', trophies: 900 }),                // trophy, all high: kept
    battle('#P1', 3, { type: 'ranked', trophies: 300 }),                // low trophy / bots: dropped
    battle('#P1', 4, { type: 'friendly' }),                             // friendly: dropped
    battle('#P1', 5, { mode: 'soloShowdown' }),                         // no teams of equal size below
    { ...battle('#P1', 6), battle: { ...battle('#P1', 6).battle, result: 'draw' } }, // draw: dropped
  ] }];
  logs[0].items[5].battle.teams = [[{ tag: '#P1', brawler: { id: 1 } }]];
  const d = tally(logs, ['#P1'], 0);
  assert.equal(d.battles.ranked, 2);
  assert.equal(d.battles.trophy, 1);
  assert.equal(d.battles.skippedLowTrophy, 1);
  const m = d.maps['gemGrab|hardrockmine'];
  assert.equal(m.r.n, 2);
  assert.equal(m.t.n, 1);
  assert.deepEqual(m.r.b[16000000], [2, 2, 0, 0]); // on my side, won both
  assert.deepEqual(m.r.b[16000003], [0, 0, 2, 0]); // other side, lost both
  assert.equal(m.r.sw, 2);
});

test('tally de-duplicates games seen from both sides and respects the cutoff', () => {
  const g = battle('#P1', 0);
  const fromOther = structuredClone(g);
  fromOther.battle.result = 'defeat';
  fromOther.battle.teams.reverse();
  fromOther.battle.teams[0][0].tag = '#P2';
  g.battle.teams[1][0].tag = '#P2';
  const d = tally([{ items: [g] }, { items: [fromOther] }], ['#P1', '#P2'], 0);
  assert.equal(d.battles.ranked, 1);

  const old = battle('#P1', 0, { t: T0 - 3600e3 });
  const d2 = tally([{ items: [old, battle('#P1', 1)] }], ['#P1'], T0 - 1800e3);
  assert.equal(d2.battles.ranked, 1);
});

test('buildMaps: ranked-only once enough ranked games, else mixed/trophy with low flag', () => {
  const items = [];
  for (let i = 0; i < 50; i++) items.push(battle('#P1', i, { win: i % 3 !== 0 }));
  for (let i = 0; i < 20; i++) items.push(battle('#P1', 100 + i, { map: 'Below Zero', id: 15000853, mode: 'brawlHockey', type: 'ranked' }));
  for (let i = 0; i < 5; i++) items.push(battle('#P1', 200 + i, { map: 'Tiny', id: 1, mode: 'heist', type: 'ranked' }));
  const day = tally([{ items }], ['#P1'], 0);
  const maps = buildMaps([day, day], new Set(['hardrockmine']));
  assert.equal(maps.length, 2); // Tiny has 10 games across both days: below the minimum
  const hrm = maps.find((m) => m.name === 'Hard Rock Mine');
  assert.equal(hrm.basis, 'ranked');
  assert.equal(hrm.sample, 100);
  assert.equal(hrm.ranked, true);
  assert.equal(hrm.low, true);
  assert.equal(hrm.mode, 'Gem Grab');
  for (let i = 1; i < hrm.picks.length; i++) assert.ok(hrm.picks[i - 1][1] >= hrm.picks[i][1], 'sorted by estimate');
  assert.equal(hrm.picks[0][4], 100); // games column
  assert.equal(hrm.picks[0][2], 50); // in half of all teams
  const bz = maps.find((m) => m.name === 'Below Zero');
  assert.equal(bz.basis, 'trophy');
  assert.equal(bz.ranked, false);
  assert.equal(bz.mode, 'Brawl Hockey');
});

test('top players winning a lot does not inflate their picks', () => {
  const items = [];
  // The sampled player wins 80% with brawler A and 60% with B (70% overall), same teammates and enemies.
  for (let i = 0; i < 100; i++) items.push(battle('#P1', i, { brawlers: [1, 10, 11, 20, 21, 22], win: i % 10 < 8 }));
  for (let i = 0; i < 100; i++) items.push(battle('#P1', 200 + i, { brawlers: [2, 10, 11, 20, 21, 22], win: i % 10 < 6 }));
  for (let i = 0; i < 3; i++) items.push(battle('#P1', 500 + i, { brawlers: [99, 10, 11, 20, 21, 22] }));
  const [m] = buildMaps([tally([{ items }], ['#P1'], 0)], new Set());
  const get = (id) => m.picks.find((p) => p[0] === id);
  assert.equal(m.topSideWin, 70.4); // 143 of 203 games won by the top player's side
  assert.equal(get(1)[3], 59.6); // A: about 10 points better than the player's usual
  assert.equal(get(2)[3], 39.6); // B: about 10 points worse, despite a 60% raw win rate
  assert.equal(get(1)[1], 56.8); // shown estimate: shrunk toward 50 with a 40-game prior
  assert.equal(get(2)[1], 42.5);
  assert.ok(Math.abs(get(10)[1] - 50) < 0.1, 'teammates on every game: neutral');
  assert.ok(Math.abs(get(20)[1] - 50) < 0.1, 'enemies on every game: neutral');
  assert.equal(m.picks[0][0], 1);
  assert.ok(!get(99), 'under 10 games: not listed');
});

test('Ranked games are split by the lowest rank in the game', () => {
  const items = [
    battle('#P1', 0, { trophies: 15 }), // Mythic: all Ranked only
    battle('#P1', 1, { trophies: 17 }), // Legendary
    battle('#P1', 2, { trophies: 20 }), // Masters
  ];
  items[2].battle.teams[1][2].brawler.trophies = 18; // one Legendary player: not a Masters+ game
  const d = tally([{ items }], ['#P1'], 0);
  const m = d.maps['gemGrab|hardrockmine'];
  assert.equal(m.r.n, 3);
  assert.equal(m.rL.n, 2);
  assert.equal(m.rM.n, 0);
  assert.equal(d.battles.legendary, 2);
});

test('crawl picks Legendary+ players met in Ranked games', () => {
  const items = [battle('#P1', 0, { trophies: 17 }), battle('#P1', 1, { trophies: 12 }), battle('#P1', 2, { type: 'ranked', trophies: 2000 })];
  const got = crawlTags([{ items }], new Set(['#P1']), 100);
  assert.equal(got.length, 5); // the 5 other players of the Legendary game only
  assert.ok(!got.includes('#P1'));
  assert.equal(crawlTags([{ items }], new Set(), 2).length, 2);
});

test('new ranking: Masters+ when available, pick rate nudges the prior', () => {
  const items = [];
  for (let i = 0; i < 200; i++) items.push(battle('#P1', i, { trophies: 20, win: i % 2 === 0 }));
  const [m] = buildMaps([tally([{ items }], ['#P1'], 0)], new Set());
  assert.equal(m.basis, 'ranked');
  assert.equal(m.shadow.basis, 'masters');
  assert.equal(m.shadow.sample, 200);
  assert.equal(m.mastersGames, 200);

  // two brawlers, both exactly 50% raw; the one picked 10x more often ranks higher with the pick prior
  const a = { n: 100, sw: 50, b: { 1: [50, 25, 50, 25], 2: [5, 3, 5, 2], 3: [20, 10, 20, 10] } };
  const flat = rankBrawlers(a);
  const pp = rankBrawlers(a, { pickPrior: true });
  assert.equal(flat.picks.find((p) => p[0] === 1)[1], 50);
  assert.ok(pp.picks.find((p) => p[0] === 1)[1] > 50);
  assert.ok(pp.picks.find((p) => p[0] === 2)[1] < 50);
});

test('parseRotation turns API slots into ISO times', () => {
  const r = parseRotation([
    { startTime: '20261120T080000.000Z', endTime: '20261121T080000.000Z', slotId: 2, event: { id: 15000853, mode: 'brawlHockey', map: 'Below Zero', modifiers: [] } },
    { startTime: '20261120T080000.000Z', endTime: '20261121T080000.000Z', slotId: 1, event: { id: 15000007, mode: 'gemGrab', map: 'Hard Rock Mine' } },
    { startTime: 'x', endTime: 'bad', slotId: 3, event: { map: 'Broken' } },
  ]);
  assert.equal(r.length, 2);
  assert.equal(r[0].map, 'Hard Rock Mine');
  assert.equal(r[1].end, '2026-11-21T08:00:00.000Z');
  assert.equal(r[1].mode, 'Brawl Hockey');
  assert.equal(r[1].solo, false);
  assert.equal(parseRotation([{ endTime: '20261121T080000.000Z', event: { id: 1, mode: 'soloShowdown', map: 'Truth' } }])[0].solo, true);
});

// ---------- end to end ----------
function mockApi({ spacingMin = 1 } = {}) {
  return createServer((req, res) => {
    const send = (j, s = 200) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(j));
    if (req.headers.authorization !== 'Bearer KEY') return send({ reason: 'accessDenied' }, 403);
    const p = new URL(req.url, 'http://x').pathname;
    let m;
    if (p === '/v1/brawlers') return send({ items: Array.from({ length: 6 }, (_, k) => ({ id: 16000000 + k, name: k === 0 ? 'EL PRIMO' : k === 1 ? 'R-T' : `BRAWLER ${k}` })) });
    if (p === '/v1/rankings/global/players') return send({ items: Array.from({ length: 6 }, (_, k) => ({ tag: `#P${k + 1}` })) });
    if ((m = p.match(/^\/v1\/players\/(.+)\/battlelog$/))) {
      const tag = decodeURIComponent(m[1]);
      const now = Date.now();
      const items = [];
      const maps = [['Hard Rock Mine', 15000007, 'gemGrab'], ['Hot Potato', 15000100, 'heist'], ['Out in the Open', 15000101, 'knockout'], ['Backyard Bowl', 15000102, 'brawlBall'], ['Ring of Fire', 15000103, 'hotZone'], ['Below Zero', 15000853, 'brawlHockey']];
      for (let i = 0; i < 25; i++) {
        const [map, id, mode] = maps[i % maps.length];
        items.push(battle(tag, i, { map, id, mode, type: mode === 'brawlHockey' ? 'ranked' : 'soloRanked', win: i % 3 > 0, t: now - (i + 1) * spacingMin * 60000 }));
      }
      return send({ items });
    }
    if (p === '/v1/events/rotation') return send([{ startTime: stamp(Date.now() - 3600e3), endTime: stamp(Date.now() + 3600e3), slotId: 1, event: { id: 15000007, mode: 'gemGrab', map: 'Hard Rock Mine' } }]);
    send({}, 404);
  });
}

const run = (script, env) =>
  new Promise((res) => execFile('node', [script], { env: { ...process.env, IMAGES: 'off', ...env } }, (err, stdout, stderr) => res({ code: err?.code ?? 0, stdout, stderr })));

test('end to end: stats + rotation from the mock API', async () => {
  const srv = mockApi().listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/v1`;
  const dir = await mkdtemp(join(tmpdir(), 'bp-'));
  const daily = join(dir, 'daily');
  await mkdir(daily);
  // an old file that should drop out of the 14-day window
  for (let k = 0; k < 15; k++) await writeFile(join(daily, `2020-01-${String(k + 1).padStart(2, '0')}.json`), JSON.stringify({ battles: { ranked: 0, trophy: 0 }, maps: {} }));
  const env = { BS_API_BASE: base, BS_API_KEY: 'KEY', BS_REGIONS: 'global', CRAWL_LIMIT: '0', MIN_TROPHIES: '500', OUT: join(dir, 'data.json'), DAILY_DIR: daily };
  const r = await run('scripts/fetch-data.mjs', env);
  const rot = await run('scripts/fetch-rotation.mjs', { ...env, OUT: join(dir, 'rotation.json') });
  srv.close();
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(rot.code, 0, rot.stderr + rot.stdout);

  const d = JSON.parse(await readFile(join(dir, 'data.json'), 'utf8'));
  assert.equal(d.maps.length, 6);
  assert.equal(d.window.days, 14);
  assert.equal((await readdir(daily)).length, 14);
  assert.equal(d.battles.ranked, 6 * (25 - 4)); // every 6th game is Brawl Hockey, a trophy game
  assert.equal(d.battles.trophy, 6 * 4);
  assert.equal(d.brawlers[16000000].n, 'El Primo');
  assert.equal(d.brawlers[16000001].n, 'R-T');
  const bz = d.maps.find((m) => m.name === 'Below Zero');
  assert.equal(bz.basis, 'trophy');
  assert.equal(bz.low, true);
  const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  assert.ok(Date.parse(state.lastRun) > 0);

  const rj = JSON.parse(await readFile(join(dir, 'rotation.json'), 'utf8'));
  assert.equal(rj.events[0].map, 'Hard Rock Mine');
  assert.ok(Date.parse(rj.events[0].end) > Date.now());
});

test('backfill files games by the day they were played', async () => {
  const srv = mockApi({ spacingMin: 2 * 60 }).listen(0); // one game every 2 hours, 25 per player: ~2 days
  const dir = await mkdtemp(join(tmpdir(), 'bp-'));
  const daily = join(dir, 'daily');
  const env = { BS_API_BASE: `http://127.0.0.1:${srv.address().port}/v1`, BS_API_KEY: 'KEY', BS_REGIONS: 'global', CRAWL_LIMIT: '0', MIN_TROPHIES: '500', OUT: join(dir, 'data.json'), DAILY_DIR: daily, BACKFILL_DAYS: '3' };
  const r = await run('scripts/fetch-data.mjs', env);
  srv.close();
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const files = (await readdir(daily)).sort();
  assert.ok(files.length <= 3 && files.every((f) => f >= new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10)), files.join()); // last 3 days only (today counts as one)
  let games = 0;
  for (const f of files) games += JSON.parse(await readFile(join(daily, f), 'utf8')).battles.ranked;
  const d = JSON.parse(await readFile(join(dir, 'data.json'), 'utf8'));
  assert.equal(games, 6 * 21, `games: ${games}`); // all Ranked games, spread over their days
  assert.ok(files.length >= 2, 'games are split across days');
  assert.equal(d.window.days, files.length);
});

test('no API key: exits non-zero and writes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bp-'));
  const r = await run('scripts/fetch-data.mjs', { BS_API_KEY: '', OUT: join(dir, 'data.json'), DAILY_DIR: join(dir, 'daily') });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /BS_API_KEY is not set/);
  await assert.rejects(readFile(join(dir, 'data.json')));
});
