// Data pipeline: filters, windowing and an end-to-end run against a mock official API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tally, buildMaps, crawlTags, fitModel, scoreRows, combosFor } from '../scripts/fetch-data.mjs';
import { parseRotation } from '../scripts/fetch-rotation.mjs';
import { parseTime, modeName } from '../scripts/lib.mjs';
import { tallyBuilds, summarizeBuilds, blankBuilds, featuresFor, tallyEffects, solveEffects, blankEffects } from '../scripts/builds.mjs';

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

// rows: [brawlerId, score %, win %, pick %, games, ban %]
test('buildMaps: Legendary+ when enough, trophy maps otherwise, low flag', () => {
  const items = [];
  for (let i = 0; i < 50; i++) items.push(battle('#P1', i, { win: i % 3 !== 0 }));
  for (let i = 0; i < 20; i++) items.push(battle('#P1', 100 + i, { map: 'Below Zero', id: 15000853, mode: 'brawlHockey', type: 'ranked' }));
  for (let i = 0; i < 5; i++) items.push(battle('#P1', 200 + i, { map: 'Tiny', id: 1, mode: 'heist', type: 'ranked' }));
  const day = tally([{ items }], ['#P1'], 0);
  const { maps, model } = buildMaps([day, day], new Set(['hardrockmine']));
  assert.equal(maps.length, 2); // Tiny has 10 games across both days: below the minimum
  const hrm = maps.find((m) => m.name === 'Hard Rock Mine');
  assert.equal(hrm.basis, 'legendary'); // 100 Masters+ games is under 150, Legendary+ is enough
  assert.equal(hrm.sample, 100);
  assert.equal(hrm.ranked, true);
  assert.equal(hrm.low, true);
  assert.equal(hrm.mode, 'Gem Grab');
  for (let i = 1; i < hrm.rows.length; i++) assert.ok(hrm.rows[i - 1][1] >= hrm.rows[i][1], 'sorted by score');
  assert.equal(hrm.rows[0][4], 100); // games column
  assert.equal(hrm.rows[0][3], 50); // in half of all teams
  const bz = maps.find((m) => m.name === 'Below Zero');
  assert.equal(bz.basis, 'trophy');
  assert.equal(bz.ranked, false);
  assert.equal(bz.mode, 'Brawl Hockey');
  assert.ok(model.ranked.score.K >= 40 && model.trophy.win.K >= 40);
});

test('top players winning a lot does not inflate their picks', () => {
  const items = [];
  // The sampled player wins 80% with brawler A and 60% with B (70% overall), same teammates and enemies.
  for (let i = 0; i < 100; i++) items.push(battle('#P1', i, { brawlers: [1, 10, 11, 20, 21, 22], win: i % 10 < 8 }));
  for (let i = 0; i < 100; i++) items.push(battle('#P1', 200 + i, { brawlers: [2, 10, 11, 20, 21, 22], win: i % 10 < 6 }));
  for (let i = 0; i < 3; i++) items.push(battle('#P1', 500 + i, { brawlers: [99, 10, 11, 20, 21, 22] }));
  const { maps: [m] } = buildMaps([tally([{ items }], ['#P1'], 0)], new Set());
  const get = (id) => m.rows.find((p) => p[0] === id);
  assert.equal(m.topSideWin, 70.4); // 143 of 203 games won by the top player's side
  // too few brawlers to fit a model: default prior worth 150 games, no presence effect
  assert.equal(get(1)[2], 53.8); // A: 80% raw is ~9.6 points above the player's usual, shrunk
  assert.equal(get(2)[2], 45.8); // B: 60% raw is ~10.4 points below, despite looking fine
  assert.ok(Math.abs(get(10)[2] - 50) < 0.1, 'teammates on every game: neutral');
  assert.ok(Math.abs(get(20)[2] - 50) < 0.1, 'enemies on every game: neutral');
  assert.equal(m.rows[0][0], 1);
  assert.ok(!get(99), 'under 10 games: not listed');
});

test('bans are counted once per game, per rank group', () => {
  const items = [battle('#P1', 0, { trophies: 20 }), battle('#P1', 1, { trophies: 17 })];
  for (const it of items) {
    const ps = it.battle.teams.flat();
    ps.forEach((p, k) => { p.bannedBrawler = { id: k < 4 ? 500 : 501 }; }); // 500 banned by four players
  }
  const m = tally([{ items }], ['#P1'], 0).maps['gemGrab|hardrockmine'];
  assert.deepEqual(m.r.bans, { 500: 2, 501: 2 });
  assert.deepEqual(m.rL.bans, { 500: 2, 501: 2 });
  assert.deepEqual(m.rM.bans, { 500: 1, 501: 1 });
});

test('fitModel finds a presence effect only when there is one', () => {
  // 30 maps x 12 brawlers. Presence (pick+ban) varies; true win rate either follows it or not.
  const make = (linked) => Array.from({ length: 30 }, (_, mi) => Array.from({ length: 12 }, (_, b) => {
    const pres = 0.02 * Math.exp(b / 4); // pick + ban share, spread over ~e^3
    const trueWr = 0.5 + (linked ? 0.02 * (b / 4 - 1.5) : 0) + 0.01 * Math.sin(mi * 7 + b * 3);
    const g = 400;
    return { id: b, g, excess: g * (trueWr - 0.5), pick: pres * 0.7, ban: pres * 0.3 };
  }));
  const linked = fitModel(make(true));
  const none = fitModel(make(false));
  assert.ok(Math.abs(linked.slope - 0.02) < 0.003, `slope ${linked.slope}`);
  assert.ok(none.slope < 0.002, `slope ${none.slope}`);
  assert.ok(linked.K > 40 && none.K > 40);
  // with a presence effect, a brawler with few games but high presence scores above a rare one
  const rows = [
    { id: 1, g: 12, excess: 0, pick: 0.3, ban: 0.2 },
    { id: 2, g: 12, excess: 0, pick: 0.01, ban: 0 },
    ...Array.from({ length: 8 }, (_, k) => ({ id: 10 + k, g: 100, excess: 0, pick: 0.05, ban: 0.01 })),
  ];
  const s = scoreRows(rows, linked, { K: 150 });
  const sc = (id) => s.find((r) => r.id === id);
  assert.ok(sc(1).score > 0.5 && sc(2).score < 0.5);
  assert.equal(sc(1).win, 0.5); // win rate ignores presence
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

test('Legendary+ even when a map has plenty of Masters+ games (Masters+ alone is too few)', () => {
  const items = [];
  for (let i = 0; i < 200; i++) items.push(battle('#P1', i, { trophies: i < 150 ? 20 : 17, win: i % 2 === 0 }));
  const { maps: [m] } = buildMaps([tally([{ items }], ['#P1'], 0)], new Set());
  assert.equal(m.basis, 'legendary');
  assert.equal(m.sample, 200); // all Legendary+ games, Masters+ included
  assert.equal(m.mastersGames, 150);
});

test('builds: first choice when one is owned, gear pair when two are owned', () => {
  const prof = (sp, gad, gears, power = 11) => ({ brawlers: [{ id: 1, power, starPowers: sp.map((id) => ({ id, name: `SP ${id}` })), gadgets: gad.map((id) => ({ id, name: `G ${id}` })), gears: gears.map((id) => ({ id, name: `GEAR ${id}` })) }] });
  const profiles = [
    ...Array.from({ length: 15 }, () => prof([10], [20, 21], [30, 31])),
    ...Array.from({ length: 5 }, () => prof([11], [21], [31, 32, 33])),
    ...Array.from({ length: 10 }, () => prof([10, 11], [20], [31, 30])),
    prof([11], [21], [30, 31], 8), // power 8: can't own a star power yet, ignored for star powers
  ];
  const names = {};
  const c = tallyBuilds(profiles, blankBuilds(), names);
  assert.equal(c.players, 31);
  assert.deepEqual(c.sp[1], { 10: 15, 11: 5 });
  assert.deepEqual(c.gad[1], { 21: 6, 20: 10 });
  assert.deepEqual(c.gear[1], { '30+31': 26 });
  assert.equal(names[10], 'Sp 10');
  const s = summarizeBuilds([c, c]);
  assert.deepEqual(s[1].sp, [10, 75, 40, 1, 25]); // 75% of 40: clearly ahead
  assert.deepEqual(s[1].gad, [20, 62.5, 32, 0, 37.5]); // 62.5% of 32: within noise, a close call
  assert.deepEqual(s[1].gear, [[30, 31], 100, 52, 1, 0]);
  assert.equal(summarizeBuilds([c])[1].gad, undefined); // 16 choices: under the minimum
});

test('combos: trios recorded for Legendary+ games, pairs derived, synergy vs solo results', () => {
  const items = [];
  // brawlers 1+2 together win 80%; with others they're average; opponents fixed
  for (let i = 0; i < 100; i++) items.push(battle('#P1', i, { trophies: 20, brawlers: [1, 2, 3, 20, 21, 22], win: i % 10 < 8 }));
  for (let i = 0; i < 100; i++) items.push(battle('#P1', 200 + i, { trophies: 20, brawlers: [1, 4, 5, 20, 21, 22], win: i % 2 === 0 }));
  for (let i = 0; i < 100; i++) items.push(battle('#P1', 400 + i, { trophies: 20, brawlers: [2, 4, 6, 20, 21, 22], win: i % 2 === 0 }));
  for (let i = 0; i < 20; i++) items.push(battle('#P1', 600 + i, { trophies: 20, brawlers: [7, 8, 9, 20, 21, 22], win: true })); // 20 lucky games: below the minimum
  const m = tally([{ items }], ['#P1'], 0).maps['gemGrab|hardrockmine'];
  assert.equal(m.rL.c[[1, 2, 3].map((x) => x - 16000000).join('.')][0], 100); // my side, 100 games (ids stored as offsets)
  assert.equal(m.r.c, undefined); // all-Ranked group doesn't store trios
  const c = combosFor(m.rL, 50);
  const duo12 = c.duos.find((d) => d[0].join() === '1,2');
  assert.ok(duo12 && duo12[2] === 100);
  assert.ok(duo12[3] > 2, `synergy ${duo12[3]}`); // together better than their solo results add up to (shrunk)
  assert.ok(!c.duos.some((d) => d[0].includes(7)), 'combos under 40 games are not listed');
  assert.equal(c.trios[0][0].join(), '1,2,3');
  assert.ok(c.duos.every((d) => d[2] >= 40) && c.trios.every((t) => t[2] >= 30));
});

test('build costs: within-player comparison recovers a known effect', () => {
  // 300 players; each plays brawler 1 (fully built) and brawler 2 (no hypercharge) 10 games each.
  // Without the hypercharge they win 10 points less; players differ in skill.
  const full = (id, hc) => ({ id, power: 11, starPowers: [{ id: 7 }], gadgets: [{ id: 8 }], gears: [{ id: 9 }, { id: 10 }], hyperCharges: hc ? [{ id: 11 }] : [], buffies: { gadget: true, starPower: true, hyperCharge: true } });
  const profiles = [], logs = new Map();
  for (let p = 0; p < 300; p++) {
    const tag = `#P${p}`, skill = 0.4 + (p % 5) * 0.05;
    profiles.push({ tag, brawlers: [full(1, true), full(2, false)] });
    const items = [];
    for (let i = 0; i < 20; i++) {
      const id = i < 10 ? 1 : 2, pWin = skill + (id === 1 ? 0.05 : -0.05);
      const win = ((i * 7 + p * 3) % 10) / 10 < pWin;
      items.push({ battle: { type: 'soloRanked', result: win ? 'victory' : 'defeat', teams: [[{ tag, brawler: { id, power: 11 } }], [{ tag: '#X', brawler: { id: 3, power: 11 } }]] } });
    }
    logs.set(tag, { items });
  }
  const acc = tallyEffects(profiles, logs, {}, blankEffects());
  const r = solveEffects(acc);
  assert.equal(r.players, 300);
  assert.ok(Math.abs(r.pieces.noHypercharge.effect + 10) < 3, `effect ${r.pieces.noHypercharge.effect}`);
  assert.ok(r.pieces.noHypercharge.penalty > 5);
  assert.equal(r.pieces.noGadget.penalty, 0); // never missing: no evidence, no penalty
  // trophy games (matched by brawler trophies) are left out of the measurement
  const trophyOnly = new Map([...logs].map(([t, l]) => [t, { items: l.items.map((it) => ({ battle: { ...it.battle, type: 'ranked' } })) }]));
  assert.equal(tallyEffects(profiles, trophyOnly, {}, blankEffects()).n, 0);
  assert.deepEqual(featuresFor({ power: 11, starPowers: [5], gadgets: [], gears: [], hyperCharges: [] }, { sp: [6, 70, 100, 1] }, 10), [1, 1, 0, 0, 1, 1, 0, 2]);
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
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/bf/brawlers') return send({ list: [{ id: 16000000, class: { name: 'Tank' } }, { id: 16000001, class: { name: 'Unknown' } }] });
    if (req.headers.authorization !== 'Bearer KEY') return send({ reason: 'accessDenied' }, 403);
    let m;
    if (p === '/v1/brawlers') return send({ items: Array.from({ length: 6 }, (_, k) => ({ id: 16000000 + k, name: k === 0 ? 'EL PRIMO' : k === 1 ? 'R-T' : `BRAWLER ${k}` })) });
    if (p === '/v1/rankings/global/players') return send({ items: Array.from({ length: 6 }, (_, k) => ({ tag: `#P${k + 1}` })) });
    if ((m = p.match(/^\/v1\/players\/([^/]+)$/))) {
      return send({ tag: decodeURIComponent(m[1]), brawlers: [
        { id: 16000000, power: 11, starPowers: [{ id: 23000076, name: 'SHELL SHOCK' }], gadgets: [{ id: 23000255, name: 'FAST FORWARD' }, { id: 23000288, name: 'CLAY PIGEONS' }], gears: [{ id: 62000002, name: 'DAMAGE' }, { id: 62000004, name: 'SHIELD' }] },
      ] });
    }
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
  new Promise((res) => execFile('node', [script], { env: { ...process.env, IMAGES: 'off', BALANCE: 'off', ...env } }, (err, stdout, stderr) => res({ code: err?.code ?? 0, stdout, stderr })));

test('end to end: stats + rotation from the mock API', async () => {
  const srv = mockApi().listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/v1`;
  const dir = await mkdtemp(join(tmpdir(), 'bp-'));
  const daily = join(dir, 'daily');
  await mkdir(daily);
  // an old file that should drop out of the 14-day window
  for (let k = 0; k < 15; k++) await writeFile(join(daily, `2020-01-${String(k + 1).padStart(2, '0')}.json`), JSON.stringify({ battles: { ranked: 0, trophy: 0 }, maps: {} }));
  const classFile = join(dir, 'classes.json');
  await writeFile(classFile, JSON.stringify({ classes: { 16000002: 'Support' } }));
  const env = { BS_API_BASE: base, BRAWLIFY_BASE: base.replace(/\/v1$/, '/bf'), CLASS_FILE: classFile, BS_API_KEY: 'KEY', BS_REGIONS: 'global', CRAWL_LIMIT: '0', MIN_TROPHIES: '500', OUT: join(dir, 'data.json'), DAILY_DIR: daily };
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
  assert.equal(d.brawlers[16000000].c, 'Tank'); // from the Brawlify mock
  assert.equal(d.brawlers[16000001].c, 'Damage Dealer'); // Brawlify's "Unknown" is ignored; the seed list fills the gap
  assert.equal(d.brawlers[16000002].c, 'Support'); // from the saved file
  assert.equal(JSON.parse(await readFile(classFile, 'utf8')).classes[16000000], 'Tank');
  const bz = d.maps.find((m) => m.name === 'Below Zero');
  assert.equal(bz.basis, 'trophy');
  assert.deepEqual(d.notInRanked, []); // every brawler in the mock also plays Ranked
  // builds from the mock profiles: one star power owned, two gears owned, both gadgets owned
  const b = d.brawlers[16000000].b;
  assert.equal(b.sp[0], 23000076);
  assert.equal(b.sp[1], 100);
  assert.ok(b.sp[2] >= 20);
  assert.deepEqual(b.gear[0], [62000002, 62000004]);
  assert.equal(b.gad, undefined); // owning both gadgets says nothing
  assert.equal(d.items[23000076].n, 'Shell Shock');
  assert.equal(d.items[62000004].n, 'Shield');
  assert.equal(bz.low, true);
  const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  assert.ok(Date.parse(state.lastRun) > 0);

  const rj = JSON.parse(await readFile(join(dir, 'rotation.json'), 'utf8'));
  assert.equal(rj.events[0].map, 'Hard Rock Mine');
  assert.ok(Date.parse(rj.events[0].end) > Date.now());
});

test('backfill files games by the day they were played', async () => {
  const srv = mockApi({ spacingMin: 90 }).listen(0); // one game every 90 min, 25 per player: 37.5 h (always inside 3 calendar days, always crosses midnight)
  const dir = await mkdtemp(join(tmpdir(), 'bp-'));
  const daily = join(dir, 'daily');
  const env = { BS_API_BASE: `http://127.0.0.1:${srv.address().port}/v1`, BS_API_KEY: 'KEY', BS_REGIONS: 'global', CRAWL_LIMIT: '0', MIN_TROPHIES: '500', OUT: join(dir, 'data.json'), DAILY_DIR: daily, BACKFILL_DAYS: '3', BRAWLIFY_BASE: 'off' };
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
  const r = await run('scripts/fetch-data.mjs', { BS_API_KEY: '', BRAWLIFY_BASE: 'off', OUT: join(dir, 'data.json'), DAILY_DIR: join(dir, 'daily') });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /BS_API_KEY is not set/);
  await assert.rejects(readFile(join(dir, 'data.json')));
});
