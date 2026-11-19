// Runs scripts/fetch-data.mjs against a local mock of the Brawlify + official APIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODES = ['Gem Grab', 'Brawl Ball', 'Heist', 'Bounty', 'Knockout', 'Hot Zone'];
const brawlers = Array.from({ length: 30 }, (_, i) => ({ id: 16000000 + i, name: `Brawler${i}`, imageUrl: `https://cdn/b/${i}.png` }));
const maps = [
  ...Array.from({ length: 8 }, (_, i) => ({ id: 15000000 + i, name: i === 0 ? 'Hard Rock Mine' : `Map ${i}`, disabled: false, imageUrl: `https://cdn/m/${i}.png`, gameMode: { name: MODES[i % 6], color: '#f0f' } })),
  { id: 15000100, name: 'Solo Map', disabled: false, gameMode: { name: 'Solo Showdown' } },
  { id: 15000101, name: 'Old Map', disabled: true, gameMode: { name: 'Gem Grab' } },
  { id: 15000102, name: 'Official Only', disabled: false, gameMode: { name: 'Heist' } },
];
const statsFor = (id) =>
  id === 15000102 ? [] : brawlers.map((b, i) => ({ brawler: b.id, winRate: 40 + ((i * 7 + id) % 25), useRate: i === 3 ? 0.05 : 1 + (i % 5) }));

function battle(tag, i) {
  const teams = [
    [{ tag, brawler: { id: 16000001 } }, { tag: `#A${i}`, brawler: { id: 16000002 } }, { tag: `#B${i}`, brawler: { id: 16000003 } }],
    [{ tag: `#C${i}`, brawler: { id: 16000004 } }, { tag: `#D${i}`, brawler: { id: 16000005 } }, { tag: `#E${i}`, brawler: { id: 16000006 } }],
  ];
  return { battleTime: `2026${i}`, event: { mode: 'heist', map: 'Official Only' }, battle: { mode: 'heist', type: 'soloRanked', result: i % 4 ? 'victory' : 'defeat', teams } };
}

function mock() {
  return createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (j, s = 200) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(j));
    const p = u.pathname;
    if (p === '/bf/brawlers') return send({ list: brawlers });
    if (p === '/bf/maps') return send({ list: maps });
    if (p === '/bf/events') return send({ active: [{ map: { id: 15000000 } }] });
    let m;
    if ((m = p.match(/^\/bf\/maps\/(\d+)$/))) {
      const map = maps.find((x) => x.id === Number(m[1]));
      return map ? send({ ...map, stats: statsFor(map.id) }) : send({}, 404);
    }
    if (req.headers.authorization !== 'Bearer KEY') return send({ reason: 'accessDenied' }, 403);
    if (p === '/bs/rankings/global/players') return send({ items: [{ tag: '#P1' }, { tag: '#P2' }] });
    if ((m = p.match(/^\/bs\/players\/(.+)\/battlelog$/))) {
      const tag = decodeURIComponent(m[1]);
      return send({ items: Array.from({ length: 20 }, (_, i) => battle(tag, i + (tag === '#P2' ? 100 : 0))) });
    }
    send({}, 404);
  });
}

const run = (env) =>
  new Promise((res) => execFile('node', ['scripts/fetch-data.mjs'], { env: { ...process.env, ...env } }, (err, stdout, stderr) => res({ code: err?.code ?? 0, stdout, stderr })));

test('pipeline builds data.json from both sources', async () => {
  const srv = mock().listen(0);
  const port = srv.address().port;
  const dir = await mkdtemp(join(tmpdir(), 'bp-'));
  const out = join(dir, 'data.json');
  const r = await run({ BRAWLIFY_BASE: `http://127.0.0.1:${port}/bf`, BS_API_BASE: `http://127.0.0.1:${port}/bs`, BS_API_KEY: 'KEY', OUT: out });
  srv.close();
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const d = JSON.parse(await readFile(out, 'utf8'));

  assert.equal(d.maps.length, 9); // 8 brawlify + 1 official-only; showdown + disabled dropped
  const hrm = d.maps.find((m) => m.name === 'Hard Rock Mine');
  assert.equal(hrm.ranked, true);
  assert.equal(hrm.active, true);
  assert.equal(hrm.src, 'brawlify');
  assert.equal(hrm.picks.length, 20);
  for (let i = 1; i < hrm.picks.length; i++) assert.ok(hrm.picks[i - 1][3] >= hrm.picks[i][3], 'sorted by score');
  // barely-used brawler should not top the list on win rate alone
  assert.notEqual(hrm.picks[0][0], 16000003);

  const off = d.maps.find((m) => m.name === 'Official Only');
  assert.equal(off.src, 'official');
  assert.equal(off.sample, 40);
  assert.ok(d.brawlers[off.picks[0][0]]);
  assert.deepEqual(d.sources.sort(), ['brawlify', 'official']);
});

test('pipeline refuses to write when there are no stats', async () => {
  const srv = createServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.url.includes('/maps/') ? { stats: [] } : req.url.endsWith('/maps') ? { list: maps } : { list: brawlers }))).listen(0);
  const dir = await mkdtemp(join(tmpdir(), 'bp-'));
  const r = await run({ BRAWLIFY_BASE: `http://127.0.0.1:${srv.address().port}`, BS_API_KEY: '', OUT: join(dir, 'data.json') });
  srv.close();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /keeping previous data/);
});
