// UX check: every user flow, in a real browser. See README.md.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright'); // require: also finds a globally installed copy
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const PORT = 5199, BASE = `http://localhost:${PORT}/`;
const DATA = JSON.parse(readFileSync(resolve(ROOT, 'site/data/data.json'), 'utf8'));

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); };

// ---------- example player (seeded, not a real account) ----------
function examplePlayer() {
  let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const brawlers = [];
  for (const id of Object.keys(DATA.brawlers).map(Number)) {
    if (rnd() < 0.3) continue;
    const r = rnd(), power = r < 0.22 ? 11 : r < 0.4 ? 10 : r < 0.58 ? 9 : r < 0.72 ? 8 : r < 0.84 ? 7 : 1 + Math.floor(rnd() * 6);
    const b = DATA.brawlers[id].b || {};
    brawlers.push({ id, power, starPowers: power >= 9 && rnd() < 0.75 ? [b.sp?.[0] ?? 1] : [], gadgets: power >= 7 && rnd() < 0.8 ? [b.gad?.[0] ?? 2] : [], gears: power >= 8 ? (b.gear?.[0] || []).slice(0, rnd() < 0.5 ? 2 : 1) : [], hyperCharges: power >= 11 && rnd() < 0.45 ? [5] : [], buffies: { gadget: false, starPower: false, hyperCharge: false } });
  }
  return JSON.stringify({ tag: '#2PP0Y8LQ', name: 'Example', trophies: 30000, fetchedAt: new Date().toISOString(), brawlers });
}
const PLAYER = examplePlayer();

// ---------- checks run on every view ----------
async function audit(p, label, { width } = {}) {
  await p.addScriptTag({ content: AXE });
  const v = await p.evaluate(async () => (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'] }))
    .violations.map((x) => `${x.id} ×${x.nodes.length} (${x.nodes[0].target.join(' ')})`));
  check(`${label}: accessibility (axe)`, !v.length, v.join('; '));
  const small = await p.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('a[href], button, input, select, summary, [tabindex="0"]')) {
      if (el.closest('[hidden]') || el.offsetParent === null) continue;
      if (el.closest('p, .foot') && el.tagName === 'A') continue; // inline text links are exempt (2.5.8)
      const r = el.getBoundingClientRect();
      if (r.width < 23.5 || r.height < 23.5) out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : el.className ? '.' + String(el.className).split(' ')[0] : ''} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return [...new Set(out)].slice(0, 6);
  });
  check(`${label}: touch targets ≥ 24px`, !small.length, small.join(', '));
  if (width) {
    const w = await p.evaluate(() => document.documentElement.scrollWidth);
    check(`${label}: no sideways scroll at ${width}px`, w <= width, `page is ${w}px wide`);
  }
}
const hash = (p) => p.evaluate(() => location.hash);
// Tap a build icon and check its tooltip is visible, inside the screen, and the topmost thing there
// (not hidden under a dialog). The tooltip ignores the pointer, so it is made hit-testable briefly.
async function tooltipOnTop(p, iconSel) {
  await p.locator(iconSel).first().click(); await p.waitForTimeout(150);
  return p.evaluate(() => {
    const t = document.querySelector('.tip');
    if (!t || t.hidden) return 'no tooltip';
    const r = t.getBoundingClientRect();
    if (r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight) return 'off screen';
    t.style.pointerEvents = 'auto';
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    t.style.pointerEvents = '';
    return top === t || t.contains(top) ? 'ok' : `covered by ${top?.id || top?.className || top?.tagName}`;
  });
}
const visible = (p, sel) => p.isVisible(sel);
const settle = (p, ms = 350) => p.waitForTimeout(ms);

async function newPage(b, opts, { player = false, wallet = null, order = null } = {}) {
  const c = await b.newContext(opts);
  await c.addInitScript(([pl, w, o]) => {
    localStorage.setItem('searchTipSeen', '1');
    if (pl) localStorage.setItem('player', pl);
    if (w) localStorage.setItem('wallet', w);
    if (o) localStorage.setItem('order', o);
  }, [player ? PLAYER : '', wallet ? JSON.stringify(wallet) : '', order || '']);
  const p = await c.newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  return p;
}

async function dialogPattern(p, label, openSel, dialogSel) {
  const opener = p.locator(openSel).first();
  await opener.click(); await settle(p, 200);
  const d = await p.evaluate((s) => { const el = document.querySelector(s); return { role: el.getAttribute('role'), modal: el.getAttribute('aria-modal'), named: !!el.getAttribute('aria-labelledby'), inside: el.contains(document.activeElement) }; }, dialogSel);
  check(`${label}: is a modal dialog with a name`, d.role === 'dialog' && d.modal === 'true' && d.named);
  check(`${label}: focus moves into it`, d.inside);
  let escaped = false;
  for (let i = 0; i < 12; i++) { await p.keyboard.press('Tab'); if (!(await p.evaluate((s) => document.querySelector(s).contains(document.activeElement), dialogSel))) escaped = true; }
  check(`${label}: Tab stays inside`, !escaped);
  await audit(p, label);
  await p.keyboard.press('Escape'); await settle(p, 150);
  check(`${label}: Escape closes it`, !(await visible(p, dialogSel)));
  check(`${label}: focus returns to what opened it`, await opener.evaluate((el) => el === document.activeElement));
}

(async () => {
  const server = spawn(process.execPath, [resolve(ROOT, 'scripts/serve.mjs'), String(PORT)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const b = await chromium.launch();
  const phone = devices['iPhone 13'];
  const pages = [];
  try {
    // ===== 1. Home and search =====
    let p = await newPage(b, phone); pages.push(p);
    await p.goto(BASE); await settle(p, 1000);
    await audit(p, 'Home');
    await p.fill('#q', 'hrm'); await settle(p, 150);
    check('Search "hrm": Hard Rock Mine first', (await p.textContent('#results li .nt')).includes('Hard Rock Mine'));
    check('Search: clear button shows while typing', await visible(p, '#qClear'));
    await p.click('#qClear'); await settle(p, 100);
    check('Clear button empties the box and keeps focus there', (await p.inputValue('#q')) === '' && await p.evaluate(() => document.activeElement.id === 'q') && !(await visible(p, '#qClear')));
    const name = Object.values(DATA.brawlers).find((x) => x.n.length >= 4).n;
    await p.fill('#q', name.slice(0, 3)); await settle(p, 150);
    check(`Search "${name.slice(0, 3)}": brawlers listed first`, await p.evaluate(() => !!document.querySelector('#results li')?.dataset.b));
    await audit(p, 'Search results');
    await p.fill('#q', 'zzzzqq'); await settle(p, 150);
    check('Search: no-results message', (await p.textContent('#hint')).length > 10);
    await p.keyboard.press('Escape'); check('Escape clears the search', (await p.inputValue('#q')) === '');

    // ===== 2. Map page, brawler card, back =====
    const rankedMap = DATA.maps.find((m) => m.ranked && m.rows?.length >= 10 && m.combos?.duos?.length) || DATA.maps.find((m) => m.ranked && m.rows?.length >= 10);
    await p.evaluate(() => localStorage.setItem('order', 'score'));
    await p.goto(BASE); await settle(p, 800);
    await p.fill('#q', rankedMap.name); await settle(p, 150); await p.keyboard.press('Enter'); await settle(p);
    check('Enter opens the map', (await hash(p)).startsWith('#m-'));
    check('Map page: back link says "Home"', (await p.textContent('#mapView .back')).includes('Home'));
    await audit(p, 'Map page');
    let tt = await tooltipOnTop(p, '#mapView .top5 .bi');
    check('Map page: build tooltip shows on top', tt === 'ok', tt);
    await p.mouse.click(5, 5); await settle(p, 100);
    check('Portrait phone: top 5 cards show build icons only', await p.evaluate(() => getComputedStyle(document.querySelector('.top5 .bn-name')).display === 'none'));
    await dialogPattern(p, 'Brawler card', '.top5 .bname >> nth=0', '#bpop');
    await p.click('.top5 .bname >> nth=0'); await settle(p, 200);
    check('Brawler card names the gadget, star power and gears', await p.evaluate(() => [...document.querySelectorAll('#bpop .bn-name')].filter((e) => e.offsetParent && e.textContent.trim()).length >= 3));
    tt = await tooltipOnTop(p, '#bpop .bi');
    check('Brawler card: build tooltip shows on top of the card', tt === 'ok', tt);
    await p.keyboard.press('Escape'); await settle(p, 150);
    await p.click('#mapView .top5 .av.pop >> nth=1'); await settle(p, 200);
    check('Tapping a brawler picture opens its card', await visible(p, '#bpop'));
    await p.keyboard.press('Escape'); await settle(p, 150);
    await p.click('#mapView .top5 .bname >> nth=0'); await settle(p, 200);
    await p.goBack(); await settle(p);
    check('Phone Back gesture closes the card and stays on the map', !(await visible(p, '#bpop')) && (await hash(p)) === `#m-${rankedMap.id}`);
    await p.click('.top5 .bname >> nth=0'); await settle(p, 200);
    await p.click('#bpop [data-frompop] >> nth=0'); await settle(p);
    check('Card: tapping a map opens it and closes the card', (await hash(p)).startsWith('#m-') && !(await visible(p, '#bpop')));
    await p.click('#mapView .back'); await settle(p);
    check('Back from that map returns to the first map with the card open again', (await hash(p)) === `#m-${rankedMap.id}` && await visible(p, '#bpop'));
    await p.keyboard.press('Escape'); await settle(p, 150);
    check('Closing the card leaves you on the same map', (await hash(p)) === `#m-${rankedMap.id}` && !(await visible(p, '#bpop')));
    if (await p.locator('[data-view=combos]').count()) {
      await p.click('[data-view=combos]'); await settle(p, 200);
      await audit(p, 'Combos');
      await p.click('[data-view=brawlers]');
    }
    await p.click('#mapView .back'); await settle(p);
    check('Map back link goes home', await visible(p, '#searchView'));

    // ===== 3. Brawler page from search -> map -> back =====
    await p.fill('#q', name); await settle(p, 150); await p.keyboard.press('Enter'); await settle(p);
    check('Search -> brawler page', (await hash(p)).startsWith('#b-') && (await p.textContent('#mapView h1')) === name);
    await audit(p, 'Brawler page');
    await p.evaluate(() => window.scrollTo(0, 400)); await settle(p, 250);
    await p.click('.bp-maps a >> nth=0'); await settle(p);
    check(`Map from brawler page: back link says "${name}"`, (await p.textContent('#mapView .back')).includes(name));
    await p.click('#mapView .back'); await settle(p);
    check('Back returns to the brawler page at the same spot', (await hash(p)).startsWith('#b-') && Math.abs(await p.evaluate(() => scrollY) - 400) < 60, `scrollY ${await p.evaluate(() => scrollY)}`);
    await p.evaluate(() => window.scrollTo(0, 0)); await settle(p, 150);
    await p.mouse.wheel(0, 600); await settle(p, 400);
    const fabDown = await p.evaluate(() => getComputedStyle(document.querySelector('#searchFab')).opacity);
    await p.mouse.wheel(0, -300); await settle(p, 400);
    const fabUp = await p.evaluate(() => getComputedStyle(document.querySelector('#searchFab')).opacity);
    check('Floating search button hides while scrolling down, returns on scroll up', fabDown === '0' && fabUp === '1', `down ${fabDown}, up ${fabUp}`);
    await p.keyboard.press('Escape'); await settle(p);
    check('Escape on a page goes back', await visible(p, '#searchView'));
    await p.goto(BASE + '#b-99999999'); await settle(p);
    check('Unknown link falls back to home', await visible(p, '#searchView'));

    // ===== 4. Account dialog =====
    await p.goto(BASE + `#m-${rankedMap.id}`); await settle(p, 800);
    await p.evaluate(() => localStorage.setItem('order', 'curated')); await p.reload(); await settle(p, 800);
    await dialogPattern(p, 'Account dialog', '#linkHere', '#acctBox');
    await p.click('#linkHere'); await p.fill('#tagIn', 'bad!'); await p.keyboard.press('Enter'); await settle(p, 200);
    check('Account dialog: bad tag error is linked to the input', await p.evaluate(() => { const i = document.querySelector('#tagIn'); return i.getAttribute('aria-invalid') === 'true' && i.getAttribute('aria-describedby') === 'acctMsg' && document.querySelector('#acctMsg').textContent.length > 10; }));
    await p.keyboard.press('Escape');
    check('Account dialog: closing keeps you on the map', (await hash(p)).startsWith('#m-'));

    // ===== 5. Upgrades flow (linked player) =====
    p = await newPage(b, phone, { player: true }); pages.push(p);
    await p.goto(BASE); await settle(p, 900);
    await p.click('#upLink'); await settle(p, 600);
    check('Header link opens Upgrades', await visible(p, '#upView'));
    check('Without amounts: best-value list', (await p.locator('.up-card').count()) > 0);
    await audit(p, 'Upgrades (no amounts)');
    await p.click('.up-presets .chip >> nth=1'); await settle(p, 300);
    check('Example amount fills both boxes', (await p.inputValue('#upPP')) !== '' && (await p.inputValue('#upCoins')) !== '');
    check('Power points box comes before coins', await p.evaluate(() => [...document.querySelectorAll('.up-field input')].map((i) => i.id).join() === 'upPP,upCoins'));
    await audit(p, 'Upgrades (plan)');
    const cardN = Math.min(1, (await p.locator('#upPlan .up-card').count()) - 1);
    const card = p.locator('#upPlan .up-card').nth(cardN);
    await card.locator('details summary').click(); await settle(p, 150);
    const y0 = await p.evaluate(() => Math.round(scrollY));
    await card.locator('details a').first().click(); await settle(p);
    check('Upgrades -> map: back link says "Upgrades"', (await p.textContent('#mapView .back')).includes('Upgrades'));
    await p.click('#mapView .back'); await settle(p);
    const y1 = await p.evaluate(() => Math.round(scrollY));
    check('Back returns to Upgrades at the same spot', (await hash(p)) === '#upgrades' && Math.abs(y1 - y0) < 60, `${y0} -> ${y1}`);
    check('…with that card\'s map list still open', await p.locator('#upPlan .up-card').nth(cardN).locator('details').evaluate((d) => d.open));
    await dialogPattern(p, 'Brawler card from Upgrades', '#upPlan .up-card .bname >> nth=0', '#bpop');
    await p.click('#upPlan .up-card .av.pop >> nth=0'); await settle(p, 200);
    check('Upgrades: tapping the picture opens the card', await visible(p, '#bpop'));
    await p.keyboard.press('Escape'); await settle(p, 150);
    await p.click('#upPlan .up-card .bname >> nth=0'); await settle(p, 200);
    await p.click('#bpop .bpop-more'); await settle(p);
    check('Card "Full page" opens the brawler page', (await hash(p)).startsWith('#b-'));
    check('Brawler page shows your power and what\'s missing', /Yours: power|don't have/.test(await p.textContent('#mapView')));
    await audit(p, 'Brawler page (linked)');

    // ===== 6. 320px phone =====
    for (const [label, url] of [['Home', ''], ['Map page', `#m-${rankedMap.id}`], ['Upgrades', '#upgrades'], ['Brawler page', `#b-${Object.keys(DATA.brawlers)[0]}`]]) {
      const q = await newPage(b, { viewport: { width: 320, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, { player: true, wallet: { c: 30000, p: 12000 } }); pages.push(q);
      await q.goto(BASE + url); await settle(q, 900);
      await audit(q, `320px ${label}`, { width: 320 });
    }

    // ===== 6b. Landscape phone: top 5 cards name the gadget and star power =====
    {
      const q = await newPage(b, devices['iPhone 13 landscape']); pages.push(q);
      await q.goto(BASE + `#m-${rankedMap.id}`); await settle(q, 900);
      check('Landscape phone: top 5 cards show gadget and star power names', await q.evaluate(() => [...document.querySelectorAll('.top5 .bn-name')].some((e) => e.offsetParent && e.textContent.trim())));
      await audit(q, 'Landscape map page', { width: 844 });
    }

    // ===== 7. Desktop keyboard =====
    p = await newPage(b, { viewport: { width: 1280, height: 900 } }); pages.push(p);
    await p.goto(BASE); await settle(p, 800);
    const noRing = [];
    for (let i = 0; i < 16; i++) {
      await p.keyboard.press('Tab');
      const f = await p.evaluate(() => { const e = document.activeElement, s = getComputedStyle(e); return { el: e.id || e.className || e.tagName, ok: (s.outlineStyle !== 'none' && s.outlineWidth !== '0px') || s.boxShadow !== 'none' || e.id === 'q' }; });
      if (!f.ok) noRing.push(f.el);
    }
    check('Desktop: every Tab stop shows focus', !noRing.length, noRing.join(', '));
    await p.keyboard.press('Control+k'); await settle(p, 100);
    check('Ctrl+K jumps to search', await p.evaluate(() => document.activeElement.id === 'q'));
    await audit(p, 'Desktop home', {});
  } catch (e) {
    check('flow ran to the end', false, e.message.split('\n')[0]);
  } finally {
    const errs = pages.flatMap((x) => x.errors || []);
    check('No JavaScript errors', !errs.length, [...new Set(errs)].join('; '));
    await b.close();
    server.kill();
  }
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${!r.ok && r.detail ? `\n    ${r.detail}` : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
