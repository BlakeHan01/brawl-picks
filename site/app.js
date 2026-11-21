import { searchMaps, initials } from './search.js';
import { API_BASE } from './config.js';
import { modeName, modeColor, isSoloMode } from './modes.js';
import { curate, costsFrom, normalizeTag } from './curate.js';
import { upgradeChains, makePlan, saveUpFor } from './advisor.js';

const $ = (s) => document.querySelector(s);
const q = $('#q');
const results = $('#results');
const hint = $('#hint');
const mapView = $('#mapView');
const searchView = $('#searchView');

let DATA = { brawlers: {}, maps: [] };
let ROT = { events: [] };
let MAPS = []; // stats maps + live maps without stats yet
let mapsById = new Map();
let sel = 0;
let shown = [];
let modeFilter = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
let rankedOnly = store.get('rankedOnly') === '1';
// Order on map pages. Rows: [brawlerId, score %, win %, pick %, games, ban %].
const ORDERS = {
  curated: { label: 'Curated pick', col: 1, head: 'Also good for you', big: 'score' },
  score: { label: 'Score', col: 1, head: 'Also strong', big: 'score' },
  banned: { label: 'Most banned', col: 5, head: 'Also banned a lot', big: 'banned' },
  win: { label: 'Win rate', col: 2, head: 'Also strong', big: 'win', more: true },
  picked: { label: 'Most picked', col: 3, head: 'Also popular', big: 'picked', more: true },
};
// The player's own brawlers (from the Worker), saved on this device.
let PLAYER = null;
try { PLAYER = JSON.parse(store.get('player') || 'null'); } catch {}
let order = ORDERS[store.get('order')] ? store.get('order') : PLAYER ? 'curated' : 'score';
// Map page view: single brawlers or best duos/trios.
let view = store.get('view') === 'combos' ? 'combos' : 'brawlers';
const rowsOf = (m) => m.rows || [];

// ---------- time ----------
function left(ms) {
  if (ms <= 0) return 'ended';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m left`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m left`;
  return `${Math.floor(h / 24)}d ${h % 24}h left`;
}
function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}
const liveEvent = (id) => ROT.events.find((e) => String(e.id) === String(id) && Date.parse(e.end) > Date.now());

// ---------- load ----------
async function getJSON(url, timeoutMs = 0) {
  try {
    const r = await fetch(url, { cache: 'no-cache', ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// ---------- live rotation (Worker), falling back to the static file ----------
let STATIC_ROT = { events: [] };
function decorate(e) {
  // Add names, colours and art the Worker doesn't send, from the static file or stats data.
  const known = STATIC_ROT.events.find((x) => String(x.id) === String(e.id)) || DATA.maps.find((m) => String(m.id) === String(e.id));
  return {
    ...e,
    mode: known?.mode || modeName(e.modeId),
    modeColor: known?.modeColor || modeColor(e.modeId),
    solo: isSoloMode(e.modeId),
    img: known?.img || (e.id ? `https://cdn.brawlify.com/maps/regular/${e.id}.png` : null),
  };
}
async function refreshRotation() {
  if (!API_BASE) return false;
  const live = await getJSON(`${API_BASE}/rotation`, 6000);
  if (!live?.events?.length) return false;
  ROT = { fetchedAt: live.fetchedAt, live: true, events: live.events.map(decorate) };
  addRotationMaps();
  markLive();
  renderFoot();
  if (mapView.hidden) renderLive();
  return true;
}
function addRotationMaps() {
  for (const e of ROT.events) {
    if (e.id == null || mapsById.has(String(e.id))) continue;
    const m = { id: String(e.id), name: e.map, mode: e.mode, modeId: e.modeId, modeColor: e.modeColor, img: e.img, solo: !!e.solo, ranked: false, rows: [] };
    m.ini = initials(m.name);
    MAPS.push(m);
    mapsById.set(m.id, m);
  }
}

async function load() {
  const [d, r] = await Promise.all([getJSON('data/data.json'), getJSON('data/rotation.json')]);
  if (d) DATA = d;
  if (r) { ROT = r; STATIC_ROT = r; }
  if (!d && !r) {
    hint.textContent = 'No data yet. The data job has not run (see README).';
    return;
  }
  MAPS = DATA.maps.map((m) => ({ ...m, id: String(m.id) }));
  const have = new Set(MAPS.map((m) => m.id));
  mapsById = new Map(MAPS.map((m) => [m.id, m]));
  for (const m of MAPS) m.ini = initials(m.name);
  addRotationMaps();
  markLive();
  renderChips();
  renderFoot();
  route();
  if (searchView.hidden === false && matchMedia('(pointer: fine)').matches) q.focus();
  setInterval(tick, 30000);
  renderAcct();
  refreshRotation(); // live timers; static file stays if the Worker is unreachable
  setInterval(refreshRotation, 5 * 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshRotation(); });
  if (PLAYER && Date.now() - Date.parse(PLAYER.fetchedAt || 0) > 15 * 60000) loadPlayer(PLAYER.tag, true);
}

function markLive() { for (const m of MAPS) m.active = !!liveEvent(m.id); }
function tick() {
  markLive();
  if (!mapView.hidden) {
    const el = $('#liveTag');
    const m = mapsById.get(currentId());
    if (el && m) { const e = liveEvent(m.id); el.textContent = e ? `Live · ${left(Date.parse(e.end) - Date.now())}` : 'Rotated out'; }
  } else renderLive();
}

function renderFoot() {
  const parts = [];
  if (DATA.generatedAt) parts.push(`Stats updated ${esc(new Date(DATA.generatedAt).toLocaleDateString())} from ${(DATA.battles?.ranked ?? 0).toLocaleString()} Ranked games (${(DATA.battles?.legendary ?? 0).toLocaleString()} Legendary+, ${(DATA.battles?.masters ?? 0).toLocaleString()} Masters+) and ${(DATA.battles?.trophy ?? 0).toLocaleString()} high-trophy games over the last ${DATA.window?.days === 1 ? 'day' : `${DATA.window?.days ?? '?'} days`}`);
  if (ROT.fetchedAt) parts.push(ROT.live ? 'timers live' : `timers checked ${ago(ROT.fetchedAt)}`);
  $('#foot').innerHTML = `${parts.join(' · ')}<br>Images from <a href="https://brawlify.com" rel="noopener">Brawlify</a>. Not affiliated with, endorsed or sponsored by Supercell.`;
}

// ---------- avatars ----------
const abbr = (n) => { const w = String(n).replace(/[^A-Za-z0-9& ]/g, ' ').split(/\s+/).filter(Boolean); return (w.length > 1 ? w[0][0] + w[1][0] : String(n).replace(/[^A-Za-z0-9]/g, '').slice(0, 2)).toUpperCase(); };
function av(id, cls = '') {
  const b = DATA.brawlers[id] || { n: '?' };
  const img = b.img ? `<img src="${esc(b.img)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  return `<span class="av ${cls}" title="${esc(b.n)}">${esc(abbr(b.n))}${img}</span>`;
}

// ---------- home ----------
const RANKED_MODES = ['gemGrab', 'brawlBall', 'heist', 'bounty', 'knockout', 'hotZone'];
const SPECIAL = 'special';
const isSpecial = (m) => !RANKED_MODES.includes(m.modeId);
function pool() {
  return MAPS.filter((m) => (!rankedOnly || m.ranked) && (!modeFilter || (modeFilter === SPECIAL ? isSpecial(m) : m.mode === modeFilter)));
}

function renderChips() {
  const modes = [...new Map(MAPS.filter((m) => !isSpecial(m)).map((m) => [m.mode, m.modeColor])).entries()].sort((a, b) => a[0].localeCompare(b[0]));
  $('#chips').innerHTML = `<button class="chip" data-f="ranked" aria-pressed="${rankedOnly}">Ranked only</button>` +
    modes.map(([k, c]) => `<button class="chip" data-mode="${esc(k)}" aria-pressed="${modeFilter === k}" style="--mc:${esc(c)}"><span class="d"></span>${esc(k)}</button>`).join('') +
    (MAPS.some(isSpecial) ? `<button class="chip" data-mode="${SPECIAL}" aria-pressed="${modeFilter === SPECIAL}" style="--mc:var(--dim)"><span class="d"></span>Special events</button>` : '');
}

function renderLive() {
  const now = Date.now();
  const evs = ROT.events.slice().sort((a, b) => Date.parse(a.end) - Date.parse(b.end));
  $('#liveWrap').hidden = !evs.length || !!q.value.trim();
  const stale = ROT.fetchedAt && now - Date.parse(ROT.fetchedAt) > 3 * 3600e3;
  $('#liveNote').textContent = stale ? `last checked ${ago(ROT.fetchedAt)}` : 'time left in rotation';
  $('#live').innerHTML = evs.map((e) => {
    const ms = Date.parse(e.end) - now;
    return `<a class="lcard ${ms <= 0 ? 'ended' : ''}" href="#m-${encodeURIComponent(e.id)}" style="--mc:${esc(e.modeColor)}">
      ${e.img ? `<img class="thumb" src="${esc(e.img)}" alt="">` : '<span class="thumb"></span>'}
      <span class="lt"><span class="lm">${esc(e.mode)}</span><span class="ln">${esc(e.map)}</span>
      <span class="lx">${ms <= 0 ? 'Next map soon' : left(ms)}</span></span></a>`;
  }).join('');
}

// Without a search, show Ranked and live maps; the rest (off-rotation special maps) sit behind
// "Other maps" so the list stays short. Search always covers every map.
let showOthers = false;
function renderResults() {
  const text = q.value.trim();
  const all = text ? searchMaps(text, pool()) : defaultList();
  const main = text || showOthers || modeFilter ? all : all.filter((m) => m.ranked || m.active);
  const hiddenCount = all.length - main.length;
  shown = main;
  sel = Math.min(sel, Math.max(0, shown.length - 1));
  $('#listHead').innerHTML = text ? 'Matches <small>↑↓ to move · Enter to open</small>' : `${showOthers || modeFilter ? 'All maps' : 'Ranked and live maps'} <small>${shown.length}</small>`;
  results.innerHTML = shown.map((m, i) => `
    <li role="option" data-id="${esc(m.id)}" class="${i === sel ? 'sel' : ''}" aria-selected="${i === sel}">
      <span class="dot" style="--mc:${esc(m.modeColor || '#888')}"></span>
      <span class="name"><span class="nt">${highlight(m.name)}</span><small class="mline">${esc(m.mode)}</small></span>
      <span class="meta">
        <span class="minis">${rowsOf(m).slice(0, 3).map((p) => av(p[0])).join('')}</span>
        ${m.ranked ? '<b class="tag">Ranked</b>' : ''}${m.active ? '<b class="tag live">Live</b>' : ''}
        <span class="mname">${esc(m.mode)}</span><span class="enter">↵</span>
      </span>
    </li>`).join('');
  hint.textContent = text && !shown.length ? 'No map matches. Try the first letter of each word.' : '';
  $('#liveWrap').hidden = !ROT.events.length || !!text;
  const more = $('#moreMaps');
  more.hidden = !!text || !!modeFilter || (!hiddenCount && !showOthers);
  more.textContent = showOthers ? 'Show fewer maps' : `Other maps (${hiddenCount})`;
  more.setAttribute('aria-expanded', String(showOthers));
}

function defaultList() {
  return pool().slice().sort((a, b) => (b.ranked - a.ranked) || (b.active - a.active) || a.mode.localeCompare(b.mode) || a.name.localeCompare(b.name));
}

const highlight = (name) => esc(name).replace(/(^|[\s-])([A-Za-z0-9])/g, '$1<u>$2</u>');

function moveSel(d) {
  if (!shown.length) return;
  sel = (sel + d + shown.length) % shown.length;
  [...results.children].forEach((li, i) => { li.classList.toggle('sel', i === sel); li.setAttribute('aria-selected', i === sel); });
  results.children[sel]?.scrollIntoView({ block: 'nearest' });
}

// ---------- map view ----------
// Class line under each brawler, coloured per class, to find them fast in the draft screen.
const CLASS_KEY = { 'Damage Dealer': 'dmg', Tank: 'tank', Marksman: 'mark', Artillery: 'art', Controller: 'ctrl', Support: 'sup', Assassin: 'asn' };
const cls = (id) => {
  const c = DATA.brawlers[id]?.c;
  return c ? `<span class="cls cls-${CLASS_KEY[c] || 'other'}">${esc(c)}</span>` : '';
};
// Best build: icons with a tooltip (hover, or tap on a phone). From what Legendary+ players chose:
// the star power / gadget they bought first when they owned only one, and the two gears they own.
// own (optional): the linked player's copy of this brawler. Then each icon also shows whether they
// have it: full colour = have it, grey with a red dot = don't have it yet.
function build(id, small = false, own = null) {
  const b = DATA.brawlers[id]?.b;
  if (!b) return '';
  const I = DATA.items || {};
  const ids = (xs) => (xs || []).map((x) => x?.id ?? x);
  const why = (x, what) => x[3]
    ? `${Math.round(x[1])}% of ${x[2]} Legendary+ players ${what}`
    : `close call: ${Math.round(x[1])}% vs ${Math.round(x[4])}% of ${x[2]} Legendary+ players`;
  const icon = (itemId, { kind = '', close = false, tip, has = null }) => {
    const it = I[itemId];
    if (!it?.img) return '';
    const state = has === null ? '' : has ? ' have' : ' missing';
    return `<span class="bi${kind ? ` ${kind}` : ''}${close ? ' close' : ''}${state}" tabindex="0" role="img" aria-label="${esc(tip)}" data-tip="${esc(tip)}"><img src="${esc(it.img)}" alt="" loading="lazy"></span>`;
  };
  const ownedNote = (has, otherIds, label) => {
    if (has === null) return '';
    if (has) return ' · You have it';
    if (!otherIds.length) return ` · You don't have a ${label} yet`;
    const other = otherIds.map((x) => I[x]?.n).filter(Boolean);
    return other.length ? ` · You have ${other.join(', ')} instead` : ` · You have the other ${label} instead`;
  };
  const parts = [];
  if (b.sp) {
    const mine = own ? ids(own.starPowers) : null;
    const has = own ? mine.includes(b.sp[0]) : null;
    parts.push(icon(b.sp[0], { kind: 'sp', close: !b.sp[3], has, tip: `Star power: ${I[b.sp[0]]?.n} · ${why(b.sp, 'chose it first')}${ownedNote(has, mine || [], 'star power')}` }));
  }
  if (b.gad) {
    const mine = own ? ids(own.gadgets) : null;
    const has = own ? mine.includes(b.gad[0]) : null;
    parts.push(icon(b.gad[0], { kind: 'gad', close: !b.gad[3], has, tip: `Gadget: ${I[b.gad[0]]?.n} · ${why(b.gad, 'chose it first')}${ownedNote(has, mine || [], 'gadget')}` }));
  }
  if (b.gear) {
    const names = b.gear[0].map((g) => I[g]?.n).filter(Boolean).join(' + ');
    const mine = own ? ids(own.gears) : null;
    for (const g of b.gear[0]) {
      const has = own ? mine.includes(g) : null;
      parts.push(icon(g, { close: !b.gear[3], has, tip: `Gears: ${names} · ${why(b.gear, 'run this pair')}${has === null ? '' : has ? ` · You have ${I[g]?.n}` : ` · You don't have ${I[g]?.n} yet`}` }));
    }
  }
  const html = parts.filter(Boolean).join('');
  return html ? `<span class="build${small ? ' sm' : ''}">${html}</span>` : '';
}
const notRanked = (id) => (DATA.notInRanked || []).includes(Number(id));
const pct = (x) => `${x.toFixed(1)}%`;
const n = (x) => Number(x).toLocaleString();

function basisText(m) {
  const d = DATA.window?.days ?? 14;
  const days = d === 1 ? 'last day' : `last ${d} days`;
  if (m.basis === 'masters') return `Based on <b>${n(m.sample)}</b> Ranked games where every player was Masters or higher, ${days}.`;
  if (m.basis === 'legendary') return `Based on <b>${n(m.sample)}</b> Ranked games where every player was Legendary or higher, ${days}.`;
  if (m.basis === 'ranked') return `Based on <b>${n(m.sample)}</b> Ranked games by top players, ${days}.`;
  if (m.basis === 'mixed') return `Based on <b>${n(m.sample)}</b> Ranked and high-trophy games by top players, ${days}.`;
  return `Based on <b>${n(m.sample)}</b> trophy games where every brawler had ${n(DATA.minTrophies ?? 750)}+ trophies, ${days}.`;
}

function renderMap(m) {
  const e = liveEvent(m.id);
  const rows = rowsOf(m);
  const head = `
    <a class="back" href="#">← All maps</a>
    <div class="maphead" style="--mc:${esc(m.modeColor || '#888')}">
      ${m.img ? `<img class="mapimg" src="${esc(m.img)}" alt="">` : ''}
      <div>
        <p class="mode">${esc(m.mode)} ${m.ranked ? '<b class="tag">Ranked</b>' : ''}${e ? `<b class="tag live" id="liveTag">Live · ${left(Date.parse(e.end) - Date.now())}</b>` : ''}</p>
        <h1>${esc(m.name)}</h1>
        ${rows.length ? `<p class="sub">${basisText(m)}</p>` : ''}
      </div>
    </div>`;
  if (!rows.length) {
    mapView.innerHTML = head + (m.solo
      ? `<p class="empty">Picks are only worked out for team modes. ${esc(m.mode)} isn't covered yet.</p>`
      : `<p class="empty">Not enough high-skill games on this map yet. Picks appear once top players have played it ${n(15)}+ times.</p>`);
    return;
  }
  const hasCombos = !!(m.combos?.duos?.length || m.combos?.trios?.length);
  const viewBar = hasCombos ? `<div class="seg viewseg" role="group" aria-label="View">
      <button data-view="brawlers" aria-pressed="${view !== 'combos'}">Brawlers</button>
      <button data-view="combos" aria-pressed="${view === 'combos'}">Combos</button></div>` : '';
  const bindView = () => mapView.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { view = b.dataset.view; store.set('view', view); renderMap(m); }));
  if (hasCombos && view === 'combos') {
    mapView.innerHTML = head + viewBar + renderCombos(m);
    bindView();
    return;
  }
  const hasBans = rows.some((r) => r[5] > 0);
  const ord = order === 'banned' && !hasBans ? 'score' : order; // trophy-game maps have no bans
  const o = ORDERS[ord];
  const B = DATA.brawlers;
  // items: { r: row, c?: curated info }. Curated pick: the player's own brawlers, top 10.
  let items;
  if (ord === 'curated') {
    const builds = Object.fromEntries(Object.entries(B).map(([id, b]) => [id, b.b]));
    items = PLAYER ? curate(rows, PLAYER, builds, costsFrom(DATA.costs)).slice(0, 10).map((c) => ({ r: c.row, c })) : [];
  } else {
    items = [...rows].sort((x, y) => y[o.col] - x[o.col] || y[1] - x[1]).slice(0, 20).map((r) => ({ r }));
  }
  const val = (it) => (it.c ? it.c.curated : it.r[o.col]);
  const top = items.slice(0, 5);
  const rest = items.slice(5);
  const vals = items.map(val);
  const hi = Math.max(...vals), lo = Math.min(...vals);
  const bar = (v) => 12 + (88 * (v - lo)) / Math.max(0.1, hi - lo);
  const big = (it) => pct(val(it));
  const bigLabel = ord === 'curated' ? 'for you' : o.big;
  // One short line of stats; picked % is in the order "Most picked" and the tooltip, bans show as
  // a chip only when they matter (20%+), unless sorting by bans.
  const sub = (r) => [
    ord !== 'win' ? `${pct(r[2])} win` : null,
    `${n(r[4])} games`,
  ].filter(Boolean);
  const banChip = (r) => (hasBans && ord !== 'banned' && r[5] >= 20 ? `<span class="banchip" title="Banned in ${pct(r[5])} of games here">Banned ${Math.round(r[5])}%</span>` : '');
  const statTip = (r) => `${pct(r[2])} win · ${pct(r[3])} picked${hasBans ? ` · ${pct(r[5])} banned` : ''} · ${n(r[4])} games`;
  // Chips only for what the icons can't show (power, hypercharge, buffies, nothing at all), plus the cost.
  const iconShown = /star power|gadget|gear/i;
  const missing = (it, small) => (it.c?.missing.length
    ? `<span class="miss${small ? ' sm' : ''}">${it.c.missing.filter((t) => !iconShown.test(t) || /^No (star power|gadget)$/.test(t) && !DATA.brawlers[it.r[0]]?.b).map((t) => `<span>${esc(t)}</span>`).join('')}${it.c.penalty ? `<span class="cost" title="Points taken off the score for what's missing from your build">−${it.c.penalty.toFixed(1)} pts</span>` : ''}</span>`
    : it.c ? `<span class="miss ok${small ? ' sm' : ''}"><span>Fully built</span></span>` : '');
  const main = Object.entries(ORDERS).filter(([k, v]) => !v.more && (k !== 'banned' || hasBans));
  const more = Object.entries(ORDERS).filter(([, v]) => v.more);
  let body;
  if (ord === 'curated' && !PLAYER) {
    body = `<div class="prompt"><p><b>Curated pick</b> shows your best 5 brawlers for this map: the strongest ones here that you've built up.</p>
      <button class="btn" id="linkHere">Add your player tag</button></div>`;
  } else if (ord === 'curated' && !items.length) {
    body = `<p class="empty">None of your power 9+ brawlers are among the picks for this map yet.</p>`;
  } else {
    body = `
    <ol class="top5">${top.map((it, i) => `
      <li>
        <span class="rank">${i + 1}</span>
        ${av(it.r[0], 'sq')}
        <span class="bn">${esc(B[it.r[0]]?.n)}</span>
        ${cls(it.r[0])}
        ${build(it.r[0], false, it.c?.own)}
        ${notRanked(it.r[0]) ? '<span class="nr">Not in Ranked</span>' : ''}
        <span class="wrbig ${(ord === 'score' || ord === 'win' || ord === 'curated') && val(it) >= 55 ? 'hi' : ''}" title="${esc(statTip(it.r))}">${big(it)}<small> ${bigLabel}</small></span>
        ${missing(it)}
        <span class="ur">${sub(it.r).join(' · ')}</span>
        ${banChip(it.r)}
      </li>`).join('')}</ol>
    <details class="legend"><summary>How is this ranked?</summary><p>${legend(m, hasBans)}</p></details>
    ${rest.length ? `<h2>${o.head} <small>ranks 6–${items.length}</small></h2>
    <ul class="rest">${rest.map((it, i) => `
      <li>
        <span class="rk">${i + 6}</span>
        ${av(it.r[0], 'sq')}
        <span class="rn"><b>${esc(B[it.r[0]]?.n)} ${cls(it.r[0])}${notRanked(it.r[0]) ? ' <span class="nr">Not in Ranked</span>' : ''}</b>${build(it.r[0], true, it.c?.own)}${missing(it, true)}<span title="${esc(statTip(it.r))}">${sub(it.r).join(' · ')}${banChip(it.r)}</span></span>
        <span class="barwrap"><span class="bar" style="width:${bar(val(it)).toFixed(0)}%"></span></span>
        <span class="wr">${big(it)}</span>
      </li>`).join('')}</ul>` : ''}`;
  }
  mapView.innerHTML = head + `
    ${viewBar}
    ${m.low ? '<p class="warn">Few games on this map so far. Treat these picks as a rough guide.</p>' : ''}
    <div class="orderbar">
      <div class="seg small" role="group" aria-label="Sort by">
        ${main.map(([k, v]) => `<button data-order="${k}" aria-pressed="${ord === k}">${v.label}</button>`).join('')}
      </div>
      <label class="more ${o.more ? 'on' : ''}"><span class="sr">More ways to sort</span>
        <select id="moreOrder" aria-label="More ways to sort">
          <option value="" ${o.more ? '' : 'selected'}>More…</option>
          ${more.map(([k, v]) => `<option value="${k}" ${ord === k ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select>
      </label>
    </div>
    ${ord === 'curated' && PLAYER ? `<p class="for">For <b>${esc(PLAYER.name)}</b> · <a href="#" id="changeAcct">change</a> · <a href="#upgrades">What to upgrade</a></p>` : ''}
    ${body}`;
  const setOrder = (k) => { order = k; store.set('order', order); renderMap(m); };
  mapView.querySelectorAll('[data-order]').forEach((b) => b.addEventListener('click', () => setOrder(b.dataset.order)));
  $('#moreOrder').addEventListener('change', (e) => { if (e.target.value) setOrder(e.target.value); });
  $('#linkHere')?.addEventListener('click', openAcct);
  $('#changeAcct')?.addEventListener('click', (e) => { e.preventDefault(); openAcct(e); });
  bindView();
}

// Best duos and trios: [[ids], win %, games, synergy points].
function renderCombos(m) {
  const B = DATA.brawlers;
  const mine = (ids) => PLAYER && ids.every((id) => PLAYER.brawlers.some((b) => b.id === id && b.power === 11));
  const block = (title, list) => !list?.length ? '' : `
    <h2>${title} <small>Top ${list.length}</small></h2>
    <ol class="combos">${list.map(([ids, win, games, syn], i) => `
      <li>
        <span class="rk">${i + 1}</span>
        <span class="cav">${ids.map((id) => av(id, 'sq')).join('')}</span>
        <span class="cn"><b>${ids.map((id) => esc(B[id]?.n)).join(' + ')}</b>
          <span>${n(games)} games${syn ? ` · <i class="${syn > 0 ? 'up' : 'down'}">${syn > 0 ? '+' : ''}${syn.toFixed(1)} together</i>` : ''}${mine(ids) ? ' · <i class="up">you have these</i>' : ''}</span></span>
        <span class="wr ${win >= 55 ? 'hi' : ''}">${pct(win)}</span>
      </li>`).join('')}</ol>`;
  return `
    ${block('Best duos', m.combos.duos)}
    ${block('Best trios', m.combos.trios)}
    <details class="legend"><summary>How are combos ranked?</summary><p><b>Combos</b> are brawlers on the same team in ${m.basis === 'masters' || m.basis === 'legendary' || m.basis === 'ranked' ? 'Legendary+ Ranked' : 'high-trophy'} games on this map, last ${DATA.window?.days ?? 14} days. <b>Win %</b> is adjusted for skill and pulled toward 50% when there are few games, like single brawlers. <b>Together</b> is how much better (or worse) the combo did than its brawlers' own results add up to: a plus means they work well together.</p></details>`;
}

function legend(m, hasBans) {
  const ordNow = order === 'banned' && !hasBans ? 'score' : order;
  if (ordNow === 'curated') {
    const c = DATA.costs?.pieces;
    const measured = c && DATA.costs.n >= 20000;
    const fmt = (k, label) => (c?.[k]?.penalty ? `${label} −${c[k].penalty}` : null);
    const list = measured ? [fmt('powerLevel', 'each power level below 11'), fmt('noHypercharge', 'no hypercharge'), fmt('buffieMissing', 'each missing buffie'), fmt('noStarPower', 'no star power'), fmt('otherStarPower', 'other star power'), fmt('noGadget', 'no gadget'), fmt('otherGadget', 'other gadget'), fmt('gearMissing', 'each missing gear')].filter(Boolean) : [];
    return `<b>Curated pick</b> ranks the brawlers you own (power 9+) by our score for this map, minus what each missing piece costs. Build icons in full colour are ones you have; grey ones with a red dot you don't have yet. ${measured
      ? `The costs are measured from ${DATA.costs.n.toLocaleString()} Ranked games of ${DATA.costs.players.toLocaleString()} Legendary+ players, comparing each player's games with and without the piece${list.length ? `: ${list.join(', ')} points` : ''}. Pieces that made no clear difference cost nothing.`
      : 'Until enough games are measured, the costs are estimates.'}`;
  }
  const skill = `Results are adjusted for skill: the players whose battle logs we read won ${m.topSideWin != null ? `${m.topSideWin.toFixed(0)}%` : 'most'} of these games, so each brawler is compared with how often its side usually won (50% = average).`;
  if (ordNow === 'banned') return `<b>Most banned</b> orders brawlers by how often good players ban them on this map: the ones they least want to face, and the ones you're least likely to get. ${skill}`;
  if (ordNow === 'score') return `<b>Score</b> is our best guess at each brawler's win rate here. It starts from how often good players pick${hasBans ? ' or ban' : ''} it on this map and moves toward its actual results as games add up, with weights fitted from the data. ${skill}`;
  if (ordNow === 'win') return `<b>Win rate</b> uses results only: few games are pulled toward 50% so luck can't put a brawler on top. ${skill}`;
  return `<b>Most picked</b> orders brawlers by how often these players chose them here. Popular brawlers are safe meta picks, but they don't always win the most. ${skill}`;
}

// ---------- upgrades: what to spend coins and power points on (see advisor.js) ----------
const upView = $('#upView');
const PRESETS = [['A little', 3000, 1000], ['A few weeks', 12000, 4000], ['A big stash', 30000, 12000]];
const parseAmount = (s) => Math.min(9999999, Math.max(0, parseInt(String(s).replace(/[^0-9]/g, ''), 10) || 0));
let WALLET = (() => { try { const w = JSON.parse(store.get('wallet') || 'null'); return w && Number.isFinite(w.c) ? w : null; } catch { return null; } })();
let upCache = null; // chains for the current player + data
function upChains() {
  const key = `${PLAYER?.tag}|${PLAYER?.fetchedAt}|${DATA.generatedAt}`;
  if (upCache?.key !== key) {
    const maps = MAPS.filter((m) => m.ranked && rowsOf(m).length);
    const builds = Object.fromEntries(Object.entries(DATA.brawlers).map(([id, b]) => [id, b.b || {}]));
    const names = Object.fromEntries(Object.entries(DATA.items || {}).map(([id, it]) => [id, it.n]));
    upCache = { key, maps, ...upgradeChains(PLAYER, maps, builds, costsFrom(DATA.costs), names) };
  }
  return upCache;
}
const KIND = { gadget: 'Gadget', starPower: 'Star power', gear: 'Gear' };
function upSteps(chain, from, to) {
  const out = [];
  let pw = null; // merge back-to-back power steps: "Power 8 → 11"
  const flush = () => { if (pw) { out.push(`<li class="up-step pw">Power <b>${pw[0]} → ${pw[1]}</b></li>`); pw = null; } };
  for (const st of chain.slice(from, to + 1)) {
    if (st.kind === 'power') { const [, a, b] = st.label.match(/(\d+)\D+(\d+)/); pw = pw ? [pw[0], b] : [a, b]; continue; }
    flush();
    const it = st.item != null && DATA.items?.[st.item];
    const icon = it?.img ? `<img src="${esc(it.img)}" alt="" loading="lazy">` : '';
    out.push(`<li class="up-step">${icon}${KIND[st.kind] ? `<span class="k">${KIND[st.kind]}</span> ${esc(st.label === KIND[st.kind] ? '' : st.label)}` : esc(st.label)}</li>`);
  }
  flush();
  return `<ul class="up-steps" aria-label="What to buy">${out.join('')}</ul>`;
}
// Plain-language reason, from where the brawler lands in your top 3 after the package.
function upWhy(id, chain, from, to, maps) {
  const own = PLAYER.brawlers.find((b) => Number(b.id) === Number(id));
  const top = chain[to].top;
  const byMode = {};
  for (const [mi] of top) { const m = maps[mi]; const r = rowsOf(m).find((x) => Number(x[0]) === Number(id)); (byMode[m.mode] ||= []).push(r ? r[2] : 50); }
  const modes = Object.entries(byMode).sort((a, b) => b[1].length - a[1].length).slice(0, 2)
    .map(([mode, w]) => `<b>${esc(mode)}</b> (${w.length} map${w.length > 1 ? 's' : ''}, ${(w.reduce((s, x) => s + x, 0) / w.length).toFixed(1)}% win)`);
  const firsts = top.filter((x) => x[1] === 1).length;
  const out = [];
  if (own && own.power < 9 && from === 0) out.push(`Gets it to power 9, so Curated pick can use it.`);
  if (top.length) out.push(`One of your top 3 on <b>${top.length} of ${maps.length}</b> Ranked maps${firsts ? `, your #1 on ${firsts}` : ''}. Strongest in ${modes.join(' and ')}.`);
  let big = null;
  for (let k = from; k <= to; k++) if (!big || chain[k].gain > big.gain) big = chain[k];
  if (to > from && big) out.push(`Biggest jump: ${esc(big.kind === 'power' || big.kind === 'hypercharge' || big.kind === 'buffie' ? big.label : `${KIND[big.kind]} ${big.label}`)}.`);
  return out.join(' ');
}
function upCard(p, rank, maxGain, U) {
  const chain = U.chains[p.id], b = DATA.brawlers[p.id] || { n: '?' };
  const own = PLAYER.brawlers.find((x) => Number(x.id) === Number(p.id));
  const top = [...chain[p.to].top].sort((x, y) => x[1] - y[1]);
  return `<li class="up-card">
    ${rank ? `<span class="up-rank" aria-hidden="true">${rank}</span>` : ''}
    ${av(p.id, 'sq up-av')}
    <div class="up-main">
      <div class="up-head">
        <h3 class="up-name">${esc(b.n)} <span class="up-now">${cls(p.id)} power ${own?.power ?? '?'} now</span></h3>
        <p class="up-cost"><span class="coin">${n(p.coins)}<span class="sr"> coins</span></span>${p.pp ? `<span class="pp">${n(p.pp)}<span class="sr"> power points</span></span>` : ''}</p>
      </div>
      ${upSteps(chain, p.from, p.to)}
      <p class="up-why">${upWhy(p.id, chain, p.from, p.to, U.maps)}</p>
      <div class="up-impact"><span class="up-bar" aria-hidden="true"><i style="width:${Math.max(4, (100 * p.gain) / maxGain).toFixed(0)}%"></i></span><span class="up-gain" title="How much this raises your average top-3 pick across Ranked maps">+${p.gain.toFixed(2)} pts</span></div>
      ${top.length ? `<details class="up-maps"><summary>Maps where it's in your top 3</summary><ul>${top.map(([mi, r]) => { const m = U.maps[mi]; return `<li><a href="#m-${esc(m.id)}"><span class="dot" style="background:${esc(m.modeColor || '#888')}"></span><span class="mn">${esc(m.name)}</span><span class="r">#${r} for you</span></a></li>`; }).join('')}</ul></details>` : ''}
    </div>
  </li>`;
}
function renderUpgrades() {
  const body = $('#upBody');
  if (!PLAYER) {
    body.innerHTML = `<div class="prompt"><p>Add your player tag and we'll look at the brawlers you own and how built up they are. Nothing is shared: it's saved on this device only.</p><button class="btn" id="upLinkTag" type="button">Add your player tag</button></div>`;
    $('#upLinkTag').addEventListener('click', openAcct);
    return;
  }
  const U = upChains();
  if (!U.maps.length) { body.innerHTML = '<p class="empty">No Ranked map data yet. Check back after the next stats update.</p>'; return; }
  body.innerHTML = `
    <form class="up-wallet" id="upWallet" novalidate>
      <div class="up-fields">
        <div class="up-field"><label for="upCoins"><span class="coin"></span>Coins</label><input id="upCoins" inputmode="numeric" autocomplete="off" placeholder="0" aria-describedby="upHint"></div>
        <div class="up-field"><label for="upPP"><span class="pp"></span>Power points</label><input id="upPP" inputmode="numeric" autocomplete="off" placeholder="0" aria-describedby="upHint"></div>
      </div>
      <p class="up-hint" id="upHint">Your coins and power points are shown at the top of the game's home screen. The game doesn't share them, so type them in.</p>
      <div class="up-presets" role="group" aria-label="Example amounts">${PRESETS.map(([l, c, p]) => `<button type="button" class="chip" data-c="${c}" data-p="${p}">${l}</button>`).join('')}</div>
    </form>
    <section class="up-summary" id="upSummary" aria-live="polite" aria-atomic="true"></section>
    <div id="upPlan"></div>
    <details class="legend"><summary>How are these picked?</summary>
      <p>For each current Ranked map, your Curated pick takes your brawlers at power 9 or higher and subtracts points for what's missing from their build. An upgrade is worth how much it raises your <b>top 3 picks</b>, averaged over all ${U.maps.length} Ranked maps, so a brawler that's strong on many maps and nearly finished comes first. Upgrades are grouped per brawler, because power 10 → 11 only pays off after the earlier steps.</p>
      <p>The plan takes the best value per coin that fits what you have, then the next, until nothing fits. A power point counts as half a coin when comparing value. ${(DATA.costs?.n ?? 0) >= 20000 ? 'The points each missing piece costs are measured from Ranked games.' : 'The points each missing piece costs are estimates until enough Ranked games are measured.'}</p>
      <p>Prices: power 1 → 11 costs 7,765 coins and 3,740 power points in total; gadget 1,000 coins; star power 2,000; gear 1,000; hypercharge 5,000; buffie 1,000 coins and 2,000 power points.</p>
    </details>`;
  const ci = $('#upCoins'), pi = $('#upPP');
  if (WALLET) { ci.value = n(WALLET.c); pi.value = n(WALLET.p); }
  let t = null;
  const update = (now = false) => {
    WALLET = ci.value === '' && pi.value === '' ? null : { c: parseAmount(ci.value), p: parseAmount(pi.value) };
    store.set('wallet', WALLET ? JSON.stringify(WALLET) : '');
    clearTimeout(t);
    if (now) upPlan(U); else t = setTimeout(() => upPlan(U), 250); // don't announce every keystroke
  };
  for (const el of [ci, pi]) {
    el.addEventListener('input', () => update());
    el.addEventListener('blur', () => { if (el.value !== '') el.value = n(parseAmount(el.value)); });
  }
  $('#upWallet').addEventListener('submit', (e) => { e.preventDefault(); update(true); });
  body.querySelectorAll('.up-presets .chip').forEach((b) => b.addEventListener('click', () => { ci.value = n(+b.dataset.c); pi.value = n(+b.dataset.p); update(true); }));
  upPlan(U);
}
function upPlan(U) {
  const sum = $('#upSummary'), out = $('#upPlan');
  document.querySelectorAll('.up-presets .chip').forEach((b) => b.setAttribute('aria-pressed', String(!!WALLET && +b.dataset.c === WALLET.c && +b.dataset.p === WALLET.p)));
  if (!Object.keys(U.chains).length) {
    sum.innerHTML = '<p class="up-big">Nothing left to upgrade</p><p>Every brawler of yours that matters on the current Ranked maps is fully built.</p>';
    out.innerHTML = '';
    return;
  }
  if (!WALLET) {
    // no amounts yet: show the best-value upgrades on the account
    const best = makePlan(U.chains, Infinity, Infinity, 5);
    const maxG = Math.max(0.01, ...best.list.map((x) => x.gain));
    sum.innerHTML = `<p>Enter your coins and power points above, or tap an example amount, for a plan that fits what you have.</p>`;
    out.innerHTML = `<h2>Best value on your account <small>top 5</small></h2><ol class="up-list">${best.list.map((p, i) => upCard(p, i + 1, maxG, U)).join('')}</ol>`;
    return;
  }
  const plan = makePlan(U.chains, WALLET.c, WALLET.p);
  const gain = plan.list.reduce((s, x) => s + x.gain, 0);
  // other brawlers only: the plan's own brawlers already have a card
  const inPlan = new Set(plan.list.map((x) => x.id));
  const later = saveUpFor(Object.fromEntries(Object.entries(U.chains).filter(([id]) => !inPlan.has(id))), plan);
  const maxG = Math.max(0.01, ...plan.list.map((x) => x.gain), ...later.map((x) => x.gain));
  const spentC = WALLET.c - plan.coinsLeft, spentP = WALLET.p - plan.ppLeft;
  sum.innerHTML = plan.list.length
    ? `<p class="up-big">${plan.list.length} upgrade${plan.list.length > 1 ? 's' : ''} <span class="up-up">+${gain.toFixed(2)} pts</span></p>
       <p>Your average top-3 pick on Ranked maps goes from <b class="num">${U.strength.toFixed(1)}</b> to <b class="num">${(U.strength + gain).toFixed(1)}</b>.</p>
       <div class="up-meter" aria-hidden="true"><i style="width:${WALLET.c ? ((100 * spentC) / WALLET.c).toFixed(0) : 0}%"></i></div>
       <p class="up-spent">Uses ${n(spentC)} of ${n(WALLET.c)} coins and ${n(spentP)} of ${n(WALLET.p)} power points.</p>`
    : `<p class="up-big">Nothing fits yet</p><p>The cheapest useful upgrade costs more than you have. Here's what's worth saving up for.</p>`;
  out.innerHTML = `${plan.list.length ? `<h2>Your plan <small>best value first</small></h2><ol class="up-list">${plan.list.map((p, i) => upCard(p, i + 1, maxG, U)).join('')}</ol>` : ''}
    ${later.length ? `<h2>Worth saving up for</h2><ul class="up-list later">${later.map((p) => upCard(p, 0, maxG, U)).join('')}</ul>` : ''}`;
}

// ---------- account (player tag -> Worker -> the player's brawlers) ----------
function renderAcct() {
  const b = $('#acctBtn');
  b.hidden = !API_BASE;
  b.innerHTML = PLAYER ? `<span class="dotok"></span><span class="an">${esc(PLAYER.name)}</span>` : 'Add player tag';
  b.title = PLAYER ? `Linked: ${PLAYER.tag}` : 'Add your player tag for Curated pick';
}
// Modal dialog per the WAI-ARIA dialog pattern: focus moves in, Tab stays inside,
// Escape closes, and focus goes back to what opened it.
let acctOpener = null;
function openAcct(e) {
  hideTip();
  // Safari doesn't focus a tapped button, so take the opener from the click
  acctOpener = e?.currentTarget instanceof HTMLElement ? e.currentTarget : document.activeElement;
  const d = $('#acctBox');
  $('#tagIn').value = PLAYER?.tag || '';
  acctMsg('');
  $('#acctRemove').hidden = !PLAYER;
  d.hidden = false;
  $('#tagIn').focus();
}
function closeAcct() {
  $('#acctBox').hidden = true;
  // the opener may have been re-rendered away; fall back to the header button
  const back = acctOpener?.isConnected && !acctOpener.closest('[hidden]') ? acctOpener : $('#acctBtn');
  acctOpener = null;
  back?.focus();
}
// invalid: the message is about what was typed (marks the input for screen readers)
function acctMsg(text, invalid = false) {
  $('#acctMsg').textContent = text;
  const i = $('#tagIn');
  if (invalid) i.setAttribute('aria-invalid', 'true'); else i.removeAttribute('aria-invalid');
}
async function loadPlayer(raw, quiet = false) {
  const tag = normalizeTag(raw);
  if (!tag) { acctMsg('That doesn\'t look like a player tag. It\'s under your name in your in-game profile, like #2PP0Y8LQ.', true); return false; }
  if (!quiet) acctMsg('Looking up your brawlers…');
  let r, body;
  try {
    r = await fetch(`${API_BASE}/player/${encodeURIComponent('#' + tag)}`, { signal: AbortSignal.timeout(10000) });
    body = await r.json().catch(() => ({}));
  } catch { r = null; }
  if (!r || !r.ok) {
    if (quiet) return false;
    acctMsg(r?.status === 404 ? `No player found for #${tag}. Check the tag in your in-game profile.`
      : r?.status === 503 ? 'The game API is busy. Try again in a minute.'
      : 'Player lookup is unavailable right now. Try again later.', r?.status === 404);
    return false;
  }
  PLAYER = body;
  store.set('player', JSON.stringify(PLAYER));
  if (!quiet) { order = 'curated'; store.set('order', order); closeAcct(); }
  renderAcct();
  route();
  return true;
}
$('#acctBtn').addEventListener('click', openAcct);
$('#acctForm').addEventListener('submit', (e) => { e.preventDefault(); loadPlayer($('#tagIn').value); });
$('#acctCancel').addEventListener('click', closeAcct);
$('#acctRemove').addEventListener('click', () => {
  PLAYER = null;
  store.set('player', '');
  if (order === 'curated') { order = 'score'; store.set('order', order); }
  closeAcct(); renderAcct(); route();
});
document.addEventListener('keydown', (e) => {
  const d = $('#acctBox');
  if (d.hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); closeAcct(); return; }
  if (e.key !== 'Tab') return;
  const f = [...d.querySelectorAll('input, button')].filter((x) => !x.hidden && !x.disabled);
  const first = f[0], last = f[f.length - 1];
  if (!d.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// ---------- build tooltips (hover, focus, or tap), kept inside the screen ----------
const tipEl = Object.assign(document.createElement('div'), { className: 'tip', hidden: true });
tipEl.setAttribute('role', 'tooltip');
document.body.append(tipEl);
let tipFor = null;
let tipAt = 0;
function showTip(el) {
  tipFor = el;
  tipAt = Date.now();
  tipEl.textContent = el.dataset.tip;
  tipEl.hidden = false;
  const r = el.getBoundingClientRect();
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  const x = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  const y = r.top - h - 6 >= 8 ? r.top - h - 6 : r.bottom + 6;
  tipEl.style.left = `${x}px`;
  tipEl.style.top = `${y}px`;
}
const hideTip = () => { tipEl.hidden = true; tipFor = null; };
// Hover only for a real mouse: on touch screens a tap opens it and a tap elsewhere closes it.
document.addEventListener('pointerover', (e) => { const b = e.pointerType === 'mouse' && e.target.closest?.('.bi'); if (b) showTip(b); });
document.addEventListener('pointerout', (e) => { if (e.pointerType === 'mouse' && e.target.closest?.('.bi')) hideTip(); });
document.addEventListener('focusin', (e) => { const b = e.target.closest?.('.bi'); if (b) showTip(b); });
document.addEventListener('focusout', (e) => { if (e.target.closest?.('.bi')) hideTip(); });
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('.bi');
  if (b && b !== tipFor) showTip(b); else if (!b) hideTip();
});
// Hide on real scrolling, not the small scroll the browser does when focusing the icon.
window.addEventListener('scroll', () => { if (Date.now() - tipAt > 500) hideTip(); }, { passive: true });

// ---------- routing ----------
// Map pages are #m-<id> (older links #/m/<id> still work).
function currentId() {
  const h = location.hash.match(/^#(?:m-|\/m\/)(.+)$/);
  return h ? decodeURIComponent(h[1]) : null;
}
function route() {
  requestAnimationFrame(() => { const r = q.getBoundingClientRect(); fab.classList.toggle('away', !searchView.hidden && r.bottom > 0 && r.top < innerHeight); });
  const id = currentId();
  const map = id && mapsById.get(id);
  upView.hidden = true;
  const onUp = location.hash === '#upgrades';
  if (onUp) $('#upLink').setAttribute('aria-current', 'page'); else $('#upLink').removeAttribute('aria-current');
  if (onUp) {
    renderUpgrades();
    upView.hidden = false;
    mapView.hidden = true;
    searchView.hidden = true;
    document.title = 'Upgrades · Brawl Picks';
    window.scrollTo(0, 0);
  } else if (map) {
    renderMap(map);
    mapView.hidden = false;
    searchView.hidden = true;
    document.title = `${map.name} · Brawl Picks`;
    window.scrollTo(0, 0);
  } else {
    mapView.hidden = true;
    searchView.hidden = false;
    document.title = 'Brawl Picks';
    renderLive();
    renderResults();
    if (matchMedia('(pointer: fine)').matches) q.focus();
  }
}

function open(id) {
  location.hash = `#m-${encodeURIComponent(id)}`;
  q.blur();
}

// ---------- events ----------
q.addEventListener('input', () => { sel = 0; renderResults(); });
q.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
  else if (e.key === 'Enter' && shown[sel]) { e.preventDefault(); open(shown[sel].id); }
  else if (e.key === 'Escape') { q.value = ''; sel = 0; renderResults(); }
});
q.addEventListener('focus', () => q.select());
$('#moreMaps').addEventListener('click', () => { showOthers = !showOthers; renderResults(); });
results.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) open(li.dataset.id);
});
$('#chips').addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (!c) return;
  if (c.dataset.f) { rankedOnly = !rankedOnly; store.set('rankedOnly', rankedOnly ? '1' : '0'); }
  else modeFilter = modeFilter === c.dataset.mode ? null : c.dataset.mode;
  renderChips();
  sel = 0;
  renderResults();
});
// Jump to search from anywhere: "/" or Ctrl+K / Cmd+K, or the floating search button.
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const shortcut = isMac ? '⌘K' : 'Ctrl+K';
function goSearch() {
  hideTip();
  if (searchView.hidden) { location.hash = ''; route(); } // show the search screen now, not after hashchange
  window.scrollTo(0, 0);
  q.focus(); // inside the tap/keypress, so phones open the keyboard
  q.select();
}
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || !$('#acctBox').hidden) return; // the dialog handles its own keys
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); goSearch(); }
  else if (e.key === '/' && !typing) { e.preventDefault(); goSearch(); }
  else if (e.key === 'Escape' && !mapView.hidden) location.hash = '';
});
const fab = $('#searchFab');
// No floating search button while the search box itself is on screen.
if ('IntersectionObserver' in window) {
  new IntersectionObserver(([en]) => fab.classList.toggle('away', en.isIntersecting && !searchView.hidden)).observe(q);
}
fab.title = `Search maps (/ or ${shortcut})`;
fab.addEventListener('click', goSearch);
$('#kbdHint').textContent = isMac ? '⌘K' : '/';

// One-time tip about the shortcut (computers only).
function maybeShowTip() {
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches || store.get('searchTipSeen') === '1') return;
  const d = $('#searchTip');
  $('#tipKeys').innerHTML = `<kbd>/</kbd> or <kbd>${shortcut}</kbd>`;
  d.hidden = false;
  const ok = $('#tipOk');
  ok.focus();
  ok.addEventListener('click', () => { d.hidden = true; store.set('searchTipSeen', '1'); q.focus(); }, { once: true });
}
setTimeout(maybeShowTip, 1200);
window.addEventListener('hashchange', route);

load();
