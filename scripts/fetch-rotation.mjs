#!/usr/bin/env node
// Current event rotation -> site/data/rotation.json (runs every 30 minutes).
// Uses the official /events/rotation endpoint, whose start and end times come from the game,
// so the site's "x min left" countdown is computed from real end times.
//
// Env: BS_API_KEY, BS_API_BASE, IMAGES, OUT (see fetch-data.mjs)

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ROOT, BS_KEY, log, official, listOf, parseTime, modeName, modeColor, isSoloMode, ensureImage } from './lib.mjs';

const OUT = resolve(ROOT, process.env.OUT || 'site/data/rotation.json');

export function parseRotation(j) {
  return listOf(j)
    .map((it) => {
      const ev = it.event || {};
      const start = parseTime(it.startTime);
      const end = parseTime(it.endTime);
      if (!ev.map || !Number.isFinite(end)) return null;
      return {
        slot: it.slotId ?? null,
        id: ev.id ?? null,
        map: ev.map,
        modeId: ev.mode,
        mode: modeName(ev.mode),
        modeColor: modeColor(ev.mode),
        solo: isSoloMode(ev.mode),
        modifiers: ev.modifiers || [],
        start: Number.isFinite(start) ? new Date(start).toISOString() : null,
        end: new Date(end).toISOString(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
}

async function main() {
  if (!BS_KEY) {
    console.error('[rotation] BS_API_KEY is not set, keeping previous rotation.');
    process.exit(1);
  }
  const events = parseRotation(await official('/events/rotation'));
  if (!events.length) throw new Error('rotation was empty');
  for (const e of events) e.img = typeof e.id === 'number' ? await ensureImage('maps', e.id) : null;

  // Only rewrite the file when the rotation itself changed, so unchanged runs don't commit.
  const prev = await readFile(OUT, 'utf8').then(JSON.parse, () => null);
  if (prev && JSON.stringify(prev.events) === JSON.stringify(events)) {
    log('rotation unchanged');
    return;
  }
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ fetchedAt: new Date().toISOString(), events }));
  log(`wrote ${events.length} events: ${events.map((e) => `${e.mode} / ${e.map}`).join('; ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('[rotation]', e.message);
    process.exit(1);
  });
}
