#!/usr/bin/env node
// Temporary: print the shapes of API fields we haven't used yet (no secrets, no player names).
import { official, listOf } from './lib.mjs';
const short = (o, n = 600) => JSON.stringify(o).slice(0, n);

const br = listOf(await official('/brawlers'));
const b0 = br.find((b) => b.starPowers?.length && b.gadgets?.length) || br[0];
console.log('BRAWLER keys:', Object.keys(b0), '\nBRAWLER sample:', short(b0, 900));

const top = listOf(await official('/rankings/global/players?limit=40'));
const prof = await official(`/players/${encodeURIComponent(top[0].tag)}`);
console.log('PROFILE keys:', Object.keys(prof));
const pb = prof.brawlers?.find((b) => b.gears?.length) || prof.brawlers?.[0];
console.log('PROFILE brawler keys:', Object.keys(pb || {}), '\nPROFILE brawler sample:', short({ ...pb }, 900));

let ranked = 0, withStats = 0, withBan = 0, banShapes = new Set(), statsSample = null, starSample = null;
const statKeys = {};
for (const p of top) {
  const log = listOf(await official(`/players/${encodeURIComponent(p.tag)}/battlelog`));
  for (const it of log) {
    const bt = it.battle || {};
    if (bt.type !== 'soloRanked' || !Array.isArray(bt.teams)) continue;
    ranked++;
    const pl = bt.teams.flat();
    if (pl.some((x) => x.stats)) withStats++;
    if (pl.some((x) => x.bannedBrawler)) withBan++;
    for (const x of pl) {
      if (x.bannedBrawler) banShapes.add(short(x.bannedBrawler, 200));
      if (x.stats) { for (const k of Object.keys(x.stats)) statKeys[k] = (statKeys[k] || 0) + 1; statsSample ||= x.stats; }
    }
    starSample ||= bt.starPlayer;
  }
}
console.log(`RANKED battles ${ranked}, with player.stats ${withStats}, with bannedBrawler ${withBan}`);
console.log('BAN shapes (first 3):', [...banShapes].slice(0, 3));
console.log('STATS keys:', statKeys, '\nSTATS sample:', short(statsSample, 900));
console.log('STARPLAYER sample:', short(starSample, 300));
