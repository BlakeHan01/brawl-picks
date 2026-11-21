// Shrink self-hosted images to the largest size the site shows them at (x3 for phone screens).
// The CDN art is 4-10x bigger than needed (gears are 562px, shown at 26px).
// Idempotent: images already small enough are left alone. Needs `sharp`; without it, does nothing.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT, log } from './lib.mjs';

// longest side in px, per image folder
export const MAX_SIDE = { 'star-powers-framed': 80, 'gadgets-framed': 80, gears: 80, maps: 360, brawlers: 216 };

export async function shrinkImages(dir = resolve(ROOT, 'site/img')) {
  let sharp;
  try { sharp = (await import('sharp')).default; } catch { log('sharp not installed: images left at full size'); return 0; }
  let done = 0, saved = 0;
  for (const [kind, max] of Object.entries(MAX_SIDE)) {
    let files;
    try { files = await readdir(resolve(dir, kind)); } catch { continue; }
    for (const f of files.filter((x) => x.endsWith('.png'))) {
      const file = resolve(dir, kind, f);
      try {
        const buf = await readFile(file);
        const { width, height } = await sharp(buf).metadata();
        if (Math.max(width, height) <= max) continue;
        const out = await sharp(buf).resize(max, max, { fit: 'inside' }).png({ compressionLevel: 9, palette: true, quality: 90 }).toBuffer();
        if (out.length >= buf.length) continue;
        await writeFile(file, out);
        done++; saved += buf.length - out.length;
      } catch (e) { log('warn: shrink', kind, f, e.message); }
    }
  }
  log(`shrank ${done} images, saved ${Math.round(saved / 1024)} KB`);
  return done;
}

if (import.meta.url === `file://${process.argv[1]}`) await shrinkImages(process.argv[2] && resolve(process.argv[2]));
