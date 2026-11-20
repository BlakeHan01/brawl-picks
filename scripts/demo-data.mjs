#!/usr/bin/env node
// Writes SAMPLE data to .demo/data/ for local UI work without an API key:
//   npm run demo   ->  http://localhost:5173 serving the site with this sample data.
// The numbers are made up. Brawler images are real (downloaded by id from the Brawlify CDN).
// .demo/ is git-ignored, so sample data can never be deployed.

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT, ensureImage, modeColor, modeName, pool } from './lib.mjs';

const OUT = resolve(ROOT, '.demo/data');

function rng(seed) {
  let a = [...seed].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0, 1779033703);
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const NAMES = 'Shelly,Colt,Bull,Brock,Rico,Spike,Barley,Jessie,Nita,Dynamike,El Primo,Mortis,Crow,Poco,Bo,Piper,Pam,Tara,Darryl,Penny,Frank,Gene,Tick,Leon,Rosa,Carl,Bibi,8-Bit,Sandy,Bea,Emz,Mr. P,Max'.split(',');
const brawlers = Object.fromEntries(NAMES.map((n, i) => [16000000 + i, { n }]));

const MAPS = {
  gemGrab: 'Hard Rock Mine,Gem Fort,Undermine,Double Swoosh',
  brawlBall: 'Backyard Bowl,Pinball Dreams,Triple Dribble,Sneaky Fields,Center Stage',
  heist: 'Hot Potato,Safe Zone,Bridge Too Far,Kaboom Canyon',
  bounty: 'Shooting Star,Layer Cake,Hideout,Dry Season',
  knockout: "Belle's Rock,Out in the Open,Goldarm Gulch,New Horizons",
  hotZone: 'Dueling Beetles,Ring of Fire,Open Business,Parallel Plays',
  brawlHockey: 'Below Zero,Slippery Showdown',
  wipeout: 'Attrition,Turnover',
  basketBrawl: 'Hoop Dreams',
};
const RANKED = new Set(['gemGrab', 'brawlBall', 'heist', 'bounty', 'knockout', 'hotZone']);

const maps = [];
let mid = 1;
for (const [mode, names] of Object.entries(MAPS)) {
  for (const name of names.split(',')) {
    const r = rng(name);
    const ranked = RANKED.has(mode);
    const sample = Math.round((ranked ? 300 : 40) + r() * (ranked ? 2500 : 200));
    const picks = Object.keys(brawlers).map((id) => {
      const g = Math.max(5, Math.round(sample * 2 * (0.01 + r() * 0.12)));
      const wr = 42 + r() * 18;
      const w = Math.round((g * wr) / 100);
      return [Number(id), Math.round((1000 * w) / g) / 10, Math.round((1000 * g) / (2 * sample)) / 10, Math.round((1000 * (w + 10)) / (g + 20)) / 10, g];
    }).sort((a, b) => b[3] - a[3]).slice(0, 20);
    maps.push({ id: `demo-${mid++}`, name, mode: modeName(mode), modeId: mode, modeColor: modeColor(mode), ranked, basis: ranked ? 'ranked' : 'trophy', sample, rankedGames: ranked ? sample : 0, low: sample < 150, img: null, picks });
  }
}

await pool(Object.keys(brawlers), 8, async (id) => { brawlers[id].img = await ensureImage('brawlers', id); });

const now = Date.now();
const live = [['Hard Rock Mine', 3.4], ['Sneaky Fields', 9.1], ['Safe Zone', 1.2], ['Shooting Star', 15.8], ["Belle's Rock", 6.5], ['Ring of Fire', 22], ['Below Zero', 30.5], ['Attrition', 0.4]];
const events = live.map(([name, h], slot) => {
  const m = maps.find((x) => x.name === name);
  return { slot: slot + 1, id: m.id, map: name, modeId: m.modeId, mode: m.mode, modeColor: m.modeColor, modifiers: [], start: new Date(now - 3600e3).toISOString(), end: new Date(now + h * 3600e3).toISOString(), img: null };
});

await mkdir(OUT, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
await writeFile(resolve(OUT, 'data.json'), JSON.stringify({ generatedAt: new Date().toISOString(), demo: true, window: { days: 14, from: today, to: today }, minTrophies: 750, battles: { ranked: 31234, trophy: 4521 }, brawlers, maps }));
await writeFile(resolve(OUT, 'rotation.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), events }));
console.log(`[demo] wrote sample data for ${maps.length} maps to ${OUT}`);
