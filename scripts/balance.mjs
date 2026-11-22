// Recent balance changes per brawler, from Liquipedia's Brawl Stars wiki (CC BY-SA 3.0).
// Each brawler page has a {{BalanceChanges}} table of dated rows; each row lists lines typed
// buff / nerf / rework / neutral / added. Rule-based, no LLM:
//   major: a rework, the brawler's release, or 3+ buffs/nerfs at once
//   minor: 1-2 buffs/nerfs
//   ignored: game-wide "neutral" lines, icon changes, shop / availability notes
// A brawler with a major or minor change in the window has its games from before the change
// left out of the rankings (fetch-data.mjs applyResets), so picks rest on the current version.

const TYPES = ['buff', 'nerf', 'rework', 'neutral', 'added'];

// wikitext -> [{ date: 'YYYY-MM-DD', lines: [{ type, text }] }], newest first
export function parseBalance(wikitext) {
  const out = [];
  const rows = String(wikitext || '').split(/\{\{\s*BCRow/i).slice(1);
  for (const row of rows) {
    const date = row.match(/\|\s*date\s*=\s*(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!date) continue;
    const lines = [];
    const re = new RegExp(`\\|\\s*(${TYPES.join('|')})\\d*\\s*=\\s*([^\\n|]*(?:\\n(?!\\s*\\|)[^\\n|]*)*)`, 'gi');
    for (const m of row.split(/\n\s*\}\}/)[0].matchAll(re)) {
      const text = clean(m[2]);
      if (text) lines.push({ type: m[1].toLowerCase(), text });
    }
    out.push({ date, lines });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

// wiki markup -> plain text: [[link|label]] -> label, '''bold''' -> bold, {{templates}} dropped
function clean(s) {
  return s.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/'{2,}/g, '').replace(/\{\{[^}]*\}\}/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

const COSMETIC = /\bicon\b|\bvoice\b|\banimation\b|\bvisual|\bskin\b|\bpin\b/i;
const AVAILABILITY = /unlock|available|starr road|shop|boxes|brawl pass|\$\d|store/i;
const RELEASE = /(?:was|were) released|became available|could be unlocked/i;

// One dated row -> { kind: 'major' | 'minor' | 'new' | null, buffs, nerfs, reworks, lines }
export function classify(row) {
  const lines = row.lines.filter((l) => l.type !== 'neutral' && !(l.type === 'rework' && COSMETIC.test(l.text)));
  const release = row.lines.some((l) => l.type === 'added' && RELEASE.test(l.text));
  const stat = lines.filter((l) => l.type === 'buff' || l.type === 'nerf' || l.type === 'rework' || (l.type === 'added' && !AVAILABILITY.test(l.text)));
  const buffs = stat.filter((l) => l.type === 'buff').length, nerfs = stat.filter((l) => l.type === 'nerf').length, reworks = stat.filter((l) => l.type === 'rework').length;
  let kind = null;
  if (release) kind = 'new';
  else if (reworks || buffs + nerfs >= 3) kind = 'major';
  else if (buffs + nerfs > 0 || stat.length) kind = 'minor';
  return { kind, buffs, nerfs, reworks, lines: stat.length ? stat : lines.filter((l) => l.type === 'added') };
}

// pages: { brawlerId: wikitext } -> changes in the window, newest first
//   [{ id, date, kind, buffs, nerfs, reworks, lines }]
export function recentChanges(pages, today, days = 14) {
  const since = new Date(Date.parse(today) - (days - 1) * 864e5).toISOString().slice(0, 10);
  const out = [];
  for (const [id, wt] of Object.entries(pages)) {
    for (const row of parseBalance(wt)) {
      if (row.date < since || row.date > today) continue;
      const c = classify(row);
      if (c.kind) out.push({ id: Number(id), date: row.date, ...c });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || (a.kind === 'minor') - (b.kind === 'minor') || a.id - b.id);
}

// Fetch the pages, 50 titles per request, politely (Liquipedia API terms: identify yourself,
// gzip, at most one request every 2 seconds). names: { brawlerId: display name }.
// get(url, headers) -> JSON. Returns { brawlerId: wikitext } (missing pages are left out).
export async function fetchPages(names, get, wait = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const ALIASES = { 'Jae-Yong': 'Jae-yong' }; // Liquipedia spellings that differ from the game's
  const entries = Object.entries(names);
  const out = {};
  for (let i = 0; i < entries.length; i += 50) {
    if (i) await wait(2500);
    const batch = entries.slice(i, i + 50);
    const titles = batch.map(([, n]) => ALIASES[n] || n);
    const url = 'https://liquipedia.net/brawlstars/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&redirects=1&format=json&formatversion=2&titles=' + encodeURIComponent(titles.join('|'));
    const j = await get(url, { 'user-agent': 'brawl-picks/1.0 (https://github.com/BlakeHan01/brawl-picks)', 'accept-encoding': 'gzip' });
    const norm = new Map((j?.query?.normalized || []).map((x) => [x.from, x.to]));
    const red = new Map((j?.query?.redirects || []).map((x) => [x.from, x.to]));
    const pages = new Map((j?.query?.pages || []).map((p) => [p.title, p]));
    batch.forEach(([id], k) => {
      let t = norm.get(titles[k]) || titles[k];
      t = red.get(t) || t;
      const wt = pages.get(t)?.revisions?.[0]?.slots?.main?.content;
      if (wt) out[id] = wt;
    });
  }
  return out;
}

// ---------- Official release notes (supercell.com/brawlstars/en/blog) ----------
// Liquipedia's brawler pages can lag a patch by weeks, so Supercell's own notes come first.
// A post reads: "MAINTENANCE - NOVEMBER 11", "BALANCE CHANGES", then per brawler a heading in
// capitals ("VINCE"), one sentence on why, and "•" bullets. Bug fixes and other sections are skipped.

// HTML -> plain lines
export function htmlLines(html) {
  const t = String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/g, '&').replace(/&#39;|&rsquo;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' ');
  return t.split('\n').map((l) => l.trim()).filter(Boolean);
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const toDate = (month, day, year) => `${year}-${String(MONTHS.indexOf(month.toLowerCase()) + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const keyOf = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// One bullet -> 'buff' | 'nerf' | 'neutral', from what changed and which way.
// Costs (cooldown, decay, reload, charge time, ammo use) are bad when they go up; everything else
// (damage, health, speed, range, healing, shield, charge gained, count) is good when it goes up.
export function direction(text) {
  const t = text.toLowerCase();
  const fromTo = t.match(/from\s+([\d.]+)%?\s*(?:→|->|to)\s*([\d.]+)/) || t.match(/([\d.]+)%?\s*(?:→|->)\s*([\d.]+)/);
  let up = /increas|more |boost|now also|added/.test(t) ? 1 : /reduc|decreas|less |lower|no longer|removed/.test(t) ? -1 : 0;
  if (fromTo) up = Math.sign(parseFloat(fromTo[2]) - parseFloat(fromTo[1])) || up;
  if (/consumes ammo|now costs/.test(t)) return 'nerf';
  if (/correctly|fixed/.test(t) || !up) return 'neutral';
  const cost = /cooldown|decay|reload|charge time|delay|cost|wind-?up|cast time|ammo use|duration of (?:the )?slow on|self-damage/.test(t) && !/cooldown refund|charge gained|super charge/.test(t);
  return (cost ? -up : up) > 0 ? 'buff' : 'nerf';
}

// lines of one post, brawler names { id: name } -> [{ id, date, reason, lines: [{ type, text }] }]
export function parseReleaseNotes(lines, names, postDate) {
  const byKey = new Map(Object.entries(names).map(([id, n]) => [keyOf(n), Number(id)]));
  const out = [];
  let date = postDate, inBalance = false, cur = null;
  const year = (postDate || '').slice(0, 4) || String(new Date().getUTCFullYear());
  for (const raw of lines) {
    const l = raw.replace(/[\u{1F300}-\u{1FAFF}☀-➿️]/gu, '').trim();
    const d = l.match(/^(?:MAINTENANCE|UPDATE|HOTFIX|BALANCE CHANGES)\b.*?\b(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+(\d{1,2})/i);
    if (d) { date = toDate(d[1], d[2], year); continue; }
    if (/^BALANCE CHANGES$/i.test(l)) { inBalance = true; continue; }
    if (!inBalance) continue;
    if (/^(BUG FIXES|NEW|OTHER|QUALITY OF LIFE|COMING SOON)\b/i.test(l) && l === l.toUpperCase()) { inBalance = false; cur = null; continue; }
    // a short line in capitals is a brawler heading; unknown ones (not released yet) end the section
    if (l === l.toUpperCase() && /[A-Z]/.test(l) && l.length <= 24 && !/^[•·\-–]/.test(l)) {
      const id = byKey.get(keyOf(l));
      cur = id ? { id, date, reason: '', lines: [] } : null;
      if (cur) out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^[•·\-–]\s*/.test(l)) cur.lines.push({ type: direction(l), text: l.replace(/^[•·\-–]\s*/, '') });
    else if (!cur.reason && !cur.lines.length) cur.reason = l;
  }
  return out.filter((c) => c.lines.length);
}

// Official entry -> the same shape as recentChanges() rows
export function classifyOfficial(c) {
  const buffs = c.lines.filter((l) => l.type === 'buff').length, nerfs = c.lines.filter((l) => l.type === 'nerf').length;
  const reworks = c.lines.filter((l) => /rework|replaced|now works|changed from .* to /i.test(l.text)).length;
  const kind = reworks || c.lines.length >= 3 ? 'major' : 'minor';
  return { id: c.id, date: c.date, kind, buffs, nerfs, reworks, reason: c.reason, lines: c.lines, source: 'supercell' };
}

// Official first; Liquipedia fills brawler/dates the official notes don't cover.
export function mergeChanges(official, liquipedia) {
  const seen = new Set(official.map((c) => `${c.id}|${c.date}`));
  return [...official, ...liquipedia.filter((c) => !seen.has(`${c.id}|${c.date}`)).map((c) => ({ ...c, source: 'liquipedia' }))]
    .sort((a, b) => b.date.localeCompare(a.date) || (a.kind === 'minor') - (b.kind === 'minor') || a.id - b.id);
}

// Recent official posts: the blog index, then the newest release-note / balance posts.
// getText(url) -> HTML string. names: { id: name }. Returns parsed entries (classifyOfficial shape).
export async function fetchOfficial(getText, names, { maxPosts = 4, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const base = 'https://supercell.com';
  const index = await getText(`${base}/brawlstars/en/blog/`);
  const links = [...new Set([...String(index).matchAll(/href="(\/brawlstars\/en\/blog\/[^"]*(?:release-notes|balance)[^"]*)"/g)].map((m) => m[1]))].slice(0, maxPosts);
  const out = [];
  for (const path of links) {
    await wait(1500);
    const lines = htmlLines(await getText(base + path));
    const d = lines.map((l) => l.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})$/)).find(Boolean);
    const postDate = d ? toDate(d[1], d[2], d[3]) : null;
    out.push(...parseReleaseNotes(lines, names, postDate).filter((c) => c.date).map((c) => ({ ...classifyOfficial(c), url: base + path })));
  }
  return out;
}

// Brawlers whose rankings should only use games after a change: { id: lastChangeDate }.
// Only real balance changes count (major / minor / new); patch-day games are mixed, so the
// day of the change is dropped too.
export function resetsFrom(changes) {
  const r = {};
  for (const c of changes) if (c.kind && (!r[c.id] || c.date > r[c.id])) r[c.id] = c.date;
  return r;
}
