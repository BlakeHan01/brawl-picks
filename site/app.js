import { searchMaps, initials } from './search.js';

const $ = (s) => document.querySelector(s);
const q = $('#q');
const results = $('#results');
const hint = $('#hint');
const mapView = $('#mapView');
const rankedOnly = $('#rankedOnly');

let DATA = null;
let mapsById = new Map();
let sel = 0;
let shown = [];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- load + preload ----------
async function load() {
  try {
    const r = await fetch('data/data.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    DATA = await r.json();
  } catch {
    hint.textContent = 'No data yet — the daily data job has not run. See README.';
    return;
  }
  mapsById = new Map(DATA.maps.map((m) => [String(m.id), m]));
  for (const m of DATA.maps) m.ini = initials(m.name);
  const d = new Date(DATA.generatedAt);
  $('#foot').innerHTML = `${DATA.maps.length} maps · data updated ${esc(d.toLocaleString())} · stats from ${esc(DATA.sources.join(' + '))} · not affiliated with Supercell`;
  preloadImages();
  route();
}

// Warm the image cache in the background so opening a map is instant.
function preloadImages() {
  const urls = Object.values(DATA.brawlers).map((b) => b.img);
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 200));
  let i = 0;
  const step = () => {
    for (let n = 0; n < 8 && i < urls.length; n++, i++) new Image().src = urls[i];
    if (i < urls.length) idle(step);
  };
  idle(step);
}
const warmed = new Set();
function warmMap(m) {
  if (m?.img && !warmed.has(m.img)) { warmed.add(m.img); new Image().src = m.img; }
}

// ---------- search ----------
function pool() {
  return rankedOnly.checked ? DATA.maps.filter((m) => m.ranked) : DATA.maps;
}

function renderResults() {
  if (!DATA) return;
  const text = q.value.trim();
  shown = text ? searchMaps(text, pool()) : defaultList();
  sel = Math.min(sel, Math.max(0, shown.length - 1));
  results.innerHTML = shown.map((m, i) => `
    <li role="option" data-id="${esc(m.id)}" class="${i === sel ? 'sel' : ''}" aria-selected="${i === sel}">
      <span class="dot" style="--mc:${esc(m.modeColor || '#888')}"></span>
      <span class="name">${highlight(m.name)}</span>
      <span class="meta">${m.ranked ? '<b class="tag">Ranked</b>' : ''}${m.active ? '<b class="tag live">Live</b>' : ''}<em>${esc(m.mode)}</em></span>
    </li>`).join('');
  hint.textContent = text && !shown.length ? 'No map matches. Try the first letter of each word.' : text ? '' : 'Ranked maps first. Type initials to filter.';
  warmMap(shown[sel]);
}

function defaultList() {
  const list = pool().slice();
  list.sort((a, b) => (b.ranked - a.ranked) || (b.active - a.active) || a.mode.localeCompare(b.mode) || a.name.localeCompare(b.name));
  return list.slice(0, 40);
}

// Bold the first letter of each word so the initials pattern is visible.
function highlight(name) {
  return esc(name).replace(/(^|[\s-])([A-Za-z0-9])/g, '$1<u>$2</u>');
}

function moveSel(d) {
  if (!shown.length) return;
  sel = (sel + d + shown.length) % shown.length;
  [...results.children].forEach((li, i) => {
    li.classList.toggle('sel', i === sel);
    li.setAttribute('aria-selected', i === sel);
  });
  results.children[sel]?.scrollIntoView({ block: 'nearest' });
  warmMap(shown[sel]);
}

// ---------- map view ----------
function pct(x) { return `${x.toFixed(1)}%`; }

function renderMap(m) {
  const B = DATA.brawlers;
  const top = m.picks.slice(0, 5);
  const rest = m.picks.slice(5);
  const maxScore = m.picks[0]?.[3] || 1;
  const minScore = m.picks[m.picks.length - 1]?.[3] || 0;
  const bar = (s) => 15 + (85 * (s - minScore)) / Math.max(0.1, maxScore - minScore);

  mapView.innerHTML = `
    <div class="maphead" style="--mc:${esc(m.modeColor || '#888')}">
      ${m.img ? `<img class="mapimg" src="${esc(m.img)}" alt="" />` : ''}
      <div>
        <p class="mode">${m.modeIcon ? `<img src="${esc(m.modeIcon)}" alt="" />` : ''}${esc(m.mode)}${m.ranked ? ' · <b class="tag">Ranked</b>' : ''}${m.active ? ' <b class="tag live">Live</b>' : ''}</p>
        <h1>${esc(m.name)}</h1>
        <p class="sub">Top picks by adjusted win rate${m.sample ? ` · ${m.sample} battles sampled` : ''}</p>
      </div>
    </div>

    <ol class="top5">
      ${top.map(([id, wr, ur], i) => `
        <li>
          <span class="rank">${i + 1}</span>
          <img src="${esc(B[id]?.img)}" alt="" loading="eager" />
          <span class="bn">${esc(B[id]?.n)}</span>
          <span class="stat"><b>${pct(wr)}</b> win</span>
          <span class="stat dim">${pct(ur)} use</span>
        </li>`).join('')}
    </ol>

    ${rest.length ? `
    <h2>Also strong</h2>
    <ul class="rest">
      ${rest.map(([id, wr, ur, s], i) => `
        <li>
          <span class="rk">${i + 6}</span>
          <img src="${esc(B[id]?.img)}" alt="" loading="lazy" />
          <span class="bn">${esc(B[id]?.n)}</span>
          <span class="barwrap"><span class="bar" style="width:${bar(s).toFixed(0)}%"></span></span>
          <span class="wr">${pct(wr)}</span>
        </li>`).join('')}
    </ul>` : ''}
  `;
}

// ---------- routing ----------
function route() {
  if (!DATA) return;
  const m = location.hash.match(/^#\/m\/(.+)$/);
  const map = m && mapsById.get(decodeURIComponent(m[1]));
  if (map) {
    renderMap(map);
    mapView.hidden = false;
    results.hidden = true;
    hint.hidden = true;
    document.title = `${map.name} · Brawl Picks`;
    window.scrollTo(0, 0);
  } else {
    mapView.hidden = true;
    results.hidden = false;
    hint.hidden = false;
    document.title = 'Brawl Picks';
    renderResults();
  }
}

function open(id) {
  location.hash = `#/m/${encodeURIComponent(id)}`;
  q.blur();
}

// ---------- events ----------
q.addEventListener('input', () => {
  sel = 0;
  if (location.hash.startsWith('#/m/')) history.replaceState(null, '', '#/');
  route();
});
q.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
  else if (e.key === 'Enter' && shown[sel]) { e.preventDefault(); open(shown[sel].id); }
  else if (e.key === 'Escape') { q.value = ''; sel = 0; location.hash = '#/'; route(); }
});
q.addEventListener('focus', () => q.select());
results.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) open(li.dataset.id);
});
results.addEventListener('pointerover', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) warmMap(mapsById.get(li.dataset.id));
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); }
});
rankedOnly.checked = store.get('rankedOnly') === '1';
rankedOnly.addEventListener('change', () => { store.set('rankedOnly', rankedOnly.checked ? '1' : '0'); sel = 0; route(); });
window.addEventListener('hashchange', route);

load();
