// Map search: type the first letters of each word ("hrm" -> Hard Rock Mine).
// Pure functions so it runs in the browser and in Node tests.

export function normalize(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`.]/g, '')
    .trim();
}

export function words(name) {
  return normalize(name).split(/[^a-z0-9]+/).filter(Boolean);
}

export function initials(name) {
  return words(name).map((w) => w[0]).join('');
}

// Lower score = better match. Returns null for no match.
export function matchScore(query, name) {
  const q = normalize(query).replace(/\s+/g, ' ');
  if (!q) return null;
  const ini = initials(name);
  const full = normalize(name);
  const compactQ = q.replace(/[^a-z0-9]/g, '');

  if (compactQ && ini === compactQ) return 0; // exact initials: hrm
  if (compactQ && ini.startsWith(compactQ)) return 1 + (ini.length - compactQ.length) * 0.01; // prefix: hr
  if (full.startsWith(q)) return 2; // name prefix: hard r
  // every query word is a prefix of some name word, in order: "rock mi"
  const qw = q.split(' ').filter(Boolean);
  const nw = words(name);
  let i = 0;
  for (const w of nw) if (i < qw.length && w.startsWith(qw[i])) i++;
  if (i === qw.length) return 3;
  if (full.includes(q)) return 4; // substring
  if (compactQ.length >= 2 && isSubsequence(compactQ, ini)) return 5; // skipped words: "hm"
  return null;
}

function isSubsequence(needle, hay) {
  let i = 0;
  for (const c of hay) if (c === needle[i]) i++;
  return i === needle.length;
}

// maps: [{name, ranked, active, ...}] -> sorted matches
export function searchMaps(query, maps, { limit = 12 } = {}) {
  const out = [];
  for (const m of maps) {
    const s = matchScore(query, m.name);
    if (s === null) continue;
    // within the same match tier, ranked maps first, then maps in rotation now
    const pri = (m.ranked ? 0 : 2) + (m.active ? 0 : 1);
    out.push({ m, tier: Math.floor(s), pri, s });
  }
  out.sort((a, b) => a.tier - b.tier || a.pri - b.pri || a.s - b.s || a.m.name.localeCompare(b.m.name));
  return out.slice(0, limit).map((x) => x.m);
}

// Brawler search by name: "be" -> Belle, "mr p" -> Mr. P, "8" -> 8-Bit. Name prefixes only (plus
// substrings from 3 letters), so map initials like "hrm" don't pull in random brawlers.
// brawlers: [{ id, name }] -> best matches first
export function searchBrawlers(query, brawlers, { limit = 4 } = {}) {
  const q = normalize(query).replace(/\s+/g, ' ');
  const cq = q.replace(/[^a-z0-9]/g, '');
  if (!cq) return [];
  const out = [];
  for (const b of brawlers) {
    const full = normalize(b.name), compact = full.replace(/[^a-z0-9]/g, '');
    let s = null;
    if (compact === cq) s = 0;
    else if (compact.startsWith(cq)) s = 1;
    else if (words(b.name).some((w) => w.startsWith(cq))) s = 2;
    else if (cq.length >= 3 && compact.includes(cq)) s = 3;
    if (s !== null) out.push({ b, s });
  }
  out.sort((x, y) => x.s - y.s || x.b.name.localeCompare(y.b.name));
  return out.slice(0, limit).map((x) => x.b);
}
