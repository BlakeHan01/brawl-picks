#!/usr/bin/env node
// Zero-dependency static server for local dev: node scripts/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../site');
const args = process.argv.slice(2);
const DEMO = args.includes('--demo'); // serve data/ from .demo/data (sample data, see demo-data.mjs)
const PORT = Number(args.find((a) => /^\d+$/.test(a)) || process.env.PORT || 5173);
const DEMO_DATA = resolve(ROOT, '../.demo/data');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const clean = normalize(p).replace(/^(\.\.[/\\])+/, '');
  const demo = DEMO && clean.startsWith('/data/');
  const base = demo ? DEMO_DATA : ROOT;
  const file = join(base, demo ? clean.slice(5) : clean);
  if (!file.startsWith(base)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}${DEMO ? '  (sample data)' : ''}`));
