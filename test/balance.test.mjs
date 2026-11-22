import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBalance, classify, recentChanges, parseReleaseNotes, classifyOfficial, direction, mergeChanges, resetsFrom } from '../scripts/balance.mjs';
import { applyResets } from '../scripts/fetch-data.mjs';

const WIKI = `{{BalanceChanges
|2026={{BCYear
  |row1={{BCRow
    |date=2026-11-11
    |nerf1=Chuck's health was decreased to 4400 (from 4700).
    |rework1=Chuck's Pit Stop Star Power icon was changed.
    |neutral1=Every Brawler's movement speed was increased.
    }}
  |row2={{BCRow
    |date=2026-09-01
    |buff1=a.
    |buff2=b.
    |rework1=Chuck's [[Hypercharge]] was '''reworked'''.
    }}
  |row3={{BCRow
    |date=2026-08-01
    |added1=Chuck could be unlocked early from boxes.
    }}
  }}
}}`;

test('Liquipedia: rows, lines and kinds (icon / game-wide / availability lines ignored)', () => {
  const rows = parseBalance(WIKI);
  assert.deepEqual(rows.map((r) => r.date), ['2026-11-11', '2026-09-01', '2026-08-01']);
  assert.equal(rows[1].lines[2].text, "Chuck's Hypercharge was reworked.");
  assert.deepEqual([classify(rows[0]).kind, classify(rows[0]).nerfs, classify(rows[0]).reworks], ['minor', 1, 0]);
  assert.equal(classify(rows[1]).kind, 'major');
  assert.equal(classify(rows[2]).kind, 'new');
  assert.deepEqual(recentChanges({ 16000073: WIKI }, '2026-11-22', 14).map((c) => [c.id, c.date, c.kind]), [[16000073, '2026-11-11', 'minor']]);
});

test('official notes: brawler sections, reasons, buff/nerf from the wording', () => {
  const lines = ['November 11, 2026', 'MAINTENANCE - NOVEMBER 11', '⚖️ BALANCE CHANGES ⚖️', 'VINCE', 'His Hypercharged Super is too strong', '• Hypercharged Super: Pet health decay increased by 30%', '• Hypercharged Super: Caterpillars spawned reduced from 6 → 4',
    'WENDY', 'Shifting her to support', '• Main Attack: Damage reduced from 1000 → 800', '• Shield gained from hitting enemies increased from 30% → 38% of Main Attack damage', 'REY', '• Queen’s Gambit Gadget: Cooldown increased from 15 → 18 seconds', '🐛 BUG FIXES 🐛', '✅ Berry: Fixed'];
  const r = parseReleaseNotes(lines, { 1: 'Vince', 2: 'Wendy', 3: 'Berry' }, '2026-11-11').map(classifyOfficial);
  assert.deepEqual(r.map((c) => [c.id, c.date, c.kind, c.buffs, c.nerfs]), [[1, '2026-11-11', 'minor', 0, 2], [2, '2026-11-11', 'minor', 1, 1]]); // Rey unknown: not attached to Wendy
  assert.equal(r[0].reason, 'His Hypercharged Super is too strong');
  assert.equal(direction('Gadget: Cooldown reduced from 22 → 18 seconds'), 'buff');
  assert.equal(direction('Porter Reinforcements Gadget now consumes ammo'), 'nerf');
  assert.equal(direction('Cookie Crumbs Gadget now correctly grants Super charge'), 'neutral');
});

test('merge: official wins on the same brawler and day; resets use the latest change', () => {
  const m = mergeChanges([{ id: 1, date: '2026-11-11', kind: 'minor', lines: [] }], [{ id: 1, date: '2026-11-11', kind: 'major', lines: [] }, { id: 2, date: '2026-11-15', kind: 'minor', lines: [] }]);
  assert.deepEqual(m.map((c) => [c.id, c.source || 'supercell']), [[2, 'liquipedia'], [1, 'supercell']]);
  assert.deepEqual(resetsFrom(m), { 1: '2026-11-11', 2: '2026-11-15' });
});

test('reset: games before (and on) the change day are dropped; too few fresh days hides the brawler', () => {
  const g = (ids) => ({ n: 10, sw: 5, b: Object.fromEntries(ids.map((i) => [i, [5, 3, 5, 2]])), bans: {}, c: { '1.2.3': [1, 1, 0, 0] } });
  const day = (date) => ({ date, maps: { m1: { r: g([16000001, 16000002]) } } });
  const days = ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14'].map(day);
  const { days: out, hidden } = applyResets(days, { 16000001: '2026-11-11', 16000002: '2026-11-13' });
  assert.deepEqual([...hidden], [16000002]); // only 1 fresh day
  assert.deepEqual(out.map((d) => Object.keys(d.maps.m1.r.b).map(Number)), [[], [], [16000001], [16000001], [16000001]]);
  assert.equal(out[0].maps.m1.r.c['1.2.3'], undefined); // combos with a reset brawler go too
  assert.ok(days[0].maps.m1.r.b[16000001]); // original day files untouched
  const { stats } = applyResets(days, { 16000001: '2026-11-11', 16000002: '2026-11-13' });
  assert.deepEqual(stats[16000001], { dropped: 20, kept: 30 }); // 2 days dropped, 3 kept, 10 games a day
  assert.deepEqual(stats[16000002], { dropped: 50, kept: 0 }); // hidden: everything dropped
});

test('official notes: other layouts (title-case names, BUFFS / NERFS, reasons after, typos, mode-only sections)', () => {
  const names = { 1: 'Piper', 2: 'Gray', 3: 'Crow', 4: 'Frank', 5: 'Ollie' };
  const lines = [
    'September 1, 2026', 'Maintenance - September 16th', '📉 BALANCE CHANGES 📈',
    'A general note: Super charge rates are adjusted too.',
    'Buffs', 'Piper', 'Health increased from 2500 to 2800', 'Piper has been outshone by other marksmen for some time, so extra health will help with trading.',
    'Grey', 'Main Attack damage increased from 1160 to 1280.',
    'Nerfs', 'Crow', 'Main attack damage reduced 380 - 320',
    'Brawl Arena Only', 'Nerfs', 'Ollie', 'Damage scaling reduced from 4 to 3',
    'NANOPOWER BALANCE CHANGES', 'Frank - 3rd NanoPower: HP buff decreased 50% 35%',
    'Maps, Game Modes, Environments & Rotation Changes', 'Crow', 'Free Brawler Rotation',
  ];
  const r = parseReleaseNotes(lines, names, '2026-09-01').map(classifyOfficial);
  assert.deepEqual(r.map((c) => [c.id, c.date, c.buffs, c.nerfs]), [[1, '2026-09-16', 1, 0], [2, '2026-09-16', 1, 0], [3, '2026-09-16', 0, 1]]);
  assert.match(r[0].reason, /outshone/);
  assert.equal(r[0].lines.length, 1); // the reason is not a change line
});
