import { searchMaps, initials } from './search.js';

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
  score: { label: 'Score', col: 1, head: 'Also strong', big: 'score' },
  banned: { label: 'Most banned', col: 5, head: 'Also banned a lot', big: 'banned' },
  win: { label: 'Win rate', col: 2, head: 'Also strong', big: 'win', more: true },
  picked: { label: 'Most picked', col: 3, head: 'Also popular', big: 'picked', more: true },
};
let order = ORDERS[store.get('order')] ? store.get('order') : 'score';
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
async function getJSON(url) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function load() {
  const [d, r] = await Promise.all([getJSON('data/data.json'), getJSON('data/rotation.json')]);
  if (d) DATA = d;
  if (r) ROT = r;
  if (!d && !r) {
    hint.textContent = 'No data yet. The data job has not run (see README).';
    return;
  }
  MAPS = DATA.maps.map((m) => ({ ...m, id: String(m.id) }));
  const have = new Set(MAPS.map((m) => m.id));
  for (const e of ROT.events) {
    if (e.id == null || have.has(String(e.id))) continue;
    have.add(String(e.id));
    MAPS.push({ id: String(e.id), name: e.map, mode: e.mode, modeId: e.modeId, modeColor: e.modeColor, img: e.img, solo: !!e.solo, ranked: false, picks: [] });
  }
  mapsById = new Map(MAPS.map((m) => [m.id, m]));
  for (const m of MAPS) m.ini = initials(m.name);
  markLive();
  renderChips();
  renderFoot();
  route();
  if (searchView.hidden === false && matchMedia('(pointer: fine)').matches) q.focus();
  setInterval(tick, 30000);
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
  if (ROT.fetchedAt) parts.push(`timers checked ${ago(ROT.fetchedAt)}`);
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

function renderResults() {
  const text = q.value.trim();
  shown = text ? searchMaps(text, pool()) : defaultList();
  sel = Math.min(sel, Math.max(0, shown.length - 1));
  $('#listHead').innerHTML = text ? 'Matches <small>↑↓ to move · Enter to open</small>' : `All maps <small>${shown.length} · ranked first</small>`;
  results.innerHTML = shown.map((m, i) => `
    <li role="option" data-id="${esc(m.id)}" class="${i === sel ? 'sel' : ''}" aria-selected="${i === sel}">
      <span class="dot" style="--mc:${esc(m.modeColor || '#888')}"></span>
      <span class="name">${highlight(m.name)}</span>
      <span class="meta">
        <span class="minis">${rowsOf(m).slice(0, 3).map((p) => av(p[0])).join('')}</span>
        ${m.ranked ? '<b class="tag">Ranked</b>' : ''}${m.active ? '<b class="tag live">Live</b>' : ''}
        <span class="mname">${esc(m.mode)}</span><span class="enter">↵</span>
      </span>
    </li>`).join('');
  hint.textContent = text && !shown.length ? 'No map matches. Try the first letter of each word.' : '';
  $('#liveWrap').hidden = !ROT.events.length || !!text;
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
function build(id, small = false) {
  const b = DATA.brawlers[id]?.b;
  if (!b) return '';
  const I = DATA.items || {};
 const icon = (itemId, tip, close) => {
    const it = I[itemId];
    if (!it?.img) return '';
    const t = `${tip}: ${it.n}`;
    return `<span class="bi${close ? ' close' : ''}" tabindex="0" role="img" aria-label="${esc(t)}" data-tip="${esc(t)}"><img src="${esc(it.img)}" alt="" loading="lazy"></span>`;
  };
  const why = (x, what) => x[3]
    ? ` · ${Math.round(x[1])}% of ${x[2]} Legendary+ players ${what}`
    : ` · close call: ${Math.round(x[1])}% vs ${Math.round(x[4])}% of ${x[2]} Legendary+ players`;
  const parts = [];
  if (b.sp) parts.push(icon(b.sp[0], 'Star power', !b.sp[3]).replace(/data-tip="([^"]*)"/, (m, t) => `data-tip="${t}${esc(why(b.sp, 'chose it first'))}"`));
  if (b.gad) parts.push(icon(b.gad[0], 'Gadget', !b.gad[3]).replace(/data-tip="([^"]*)"/, (m, t) => `data-tip="${t}${esc(why(b.gad, 'chose it first'))}"`));
  if (b.gear) {
    const names = b.gear[0].map((g) => I[g]?.n).filter(Boolean).join(' + ');
    for (const g of b.gear[0]) parts.push(icon(g, 'Gear', !b.gear[3]).replace(/data-tip="([^"]*)"/, () => `data-tip="${esc(`Gears: ${names}${why(b.gear, 'run this pair')}`)}"`));
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
  const hasBans = rows.some((r) => r[5] > 0);
  const ord = order === 'banned' && !hasBans ? 'score' : order; // trophy-game maps have no bans
  const o = ORDERS[ord];
  const list = [...rows].sort((x, y) => y[o.col] - x[o.col] || y[1] - x[1]).slice(0, 20);
  const top = list.slice(0, 5);
  const rest = list.slice(5);
  const vals = list.map((r) => r[o.col]);
  const hi = Math.max(...vals), lo = Math.min(...vals);
  const bar = (v) => 12 + (88 * (v - lo)) / Math.max(0.1, hi - lo);
  const B = DATA.brawlers;
  const big = (r) => pct(r[o.col]);
  const sub = (r) => [
    ord !== 'win' ? `${pct(r[2])} win` : null,
    ord !== 'picked' ? `${pct(r[3])} picked` : null,
    hasBans && ord !== 'banned' ? `${pct(r[5])} banned` : null,
  ].filter(Boolean);
  const main = Object.entries(ORDERS).filter(([k, v]) => !v.more && (k !== 'banned' || hasBans));
  const more = Object.entries(ORDERS).filter(([, v]) => v.more);
  mapView.innerHTML = head + `
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
    <ol class="top5">${top.map((r, i) => `
      <li>
        <span class="rank">${i + 1}</span>
        ${av(r[0], 'sq')}
        <span class="bn">${esc(B[r[0]]?.n)}</span>
        ${cls(r[0])}
        ${build(r[0])}
        ${notRanked(r[0]) ? '<span class="nr">Not in Ranked</span>' : ''}
        <span class="wrbig ${(ord === 'score' || ord === 'win') && r[o.col] >= 55 ? 'hi' : ''}">${big(r)}<small> ${o.big}</small></span>
        ${sub(r).map((t) => `<span class="ur">${t}</span>`).join('')}
        <span class="ur">${n(r[4])} games</span>
      </li>`).join('')}</ol>
    <p class="legend">${legend(m, hasBans)}</p>
    ${rest.length ? `<h2>${o.head} <small>ranks 6–${list.length}</small></h2>
    <ul class="rest">${rest.map((r, i) => `
      <li>
        <span class="rk">${i + 6}</span>
        ${av(r[0], 'sq')}
        <span class="rn"><b>${esc(B[r[0]]?.n)} ${cls(r[0])}${notRanked(r[0]) ? ' <span class="nr">Not in Ranked</span>' : ''}</b>${build(r[0], true)}<span>${[...sub(r), `${n(r[4])} games`].join(' · ')}</span></span>
        <span class="barwrap"><span class="bar" style="width:${bar(r[o.col]).toFixed(0)}%"></span></span>
        <span class="wr">${big(r)}</span>
      </li>`).join('')}</ul>` : ''}`;
  const setOrder = (k) => { order = k; store.set('order', order); renderMap(m); };
  mapView.querySelectorAll('[data-order]').forEach((b) => b.addEventListener('click', () => setOrder(b.dataset.order)));
  $('#moreOrder').addEventListener('change', (e) => { if (e.target.value) setOrder(e.target.value); });
}

function legend(m, hasBans) {
  const ordNow = order === 'banned' && !hasBans ? 'score' : order;
  const skill = `Results are adjusted for skill: the players whose battle logs we read won ${m.topSideWin != null ? `${m.topSideWin.toFixed(0)}%` : 'most'} of these games, so each brawler is compared with how often its side usually won (50% = average).`;
  if (ordNow === 'banned') return `<b>Most banned</b> orders brawlers by how often good players ban them on this map: the ones they least want to face, and the ones you're least likely to get. ${skill}`;
  if (ordNow === 'score') return `<b>Score</b> is our best guess at each brawler's win rate here. It starts from how often good players pick${hasBans ? ' or ban' : ''} it on this map and moves toward its actual results as games add up, with weights fitted from the data. ${skill}`;
  if (ordNow === 'win') return `<b>Win rate</b> uses results only: few games are pulled toward 50% so luck can't put a brawler on top. ${skill}`;
  return `<b>Most picked</b> orders brawlers by how often these players chose them here. Popular brawlers are safe meta picks, but they don't always win the most. ${skill}`;
}

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
  const id = currentId();
  const map = id && mapsById.get(id);
  if (map) {
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
  if (!mapView.hidden) { location.hash = ''; route(); } // show the search screen now, not after hashchange
  window.scrollTo(0, 0);
  q.focus(); // inside the tap/keypress, so phones open the keyboard
  q.select();
}
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); goSearch(); }
  else if (e.key === '/' && !typing) { e.preventDefault(); goSearch(); }
  else if (e.key === 'Escape' && !mapView.hidden) location.hash = '';
});
const fab = $('#searchFab');
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
