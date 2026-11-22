# Brawl Picks

The best Brawl Stars brawlers for every map, from high-skill games. Live at
**https://blakehan01.github.io/brawl-picks/**

## What players get

- **Search**: map initials (`hrm` → Hard Rock Mine) or a brawler's name (`be` → Bea, Belle…).
- **Live now**: the current rotation, specialty events included, with the game's own end times.
- **Map pages**: the top brawlers, sorted by **Curated pick** (yours), **Score**, **Most banned**,
  Win rate or Most picked; best build (star power, gadget, gears); best **duos and trios**.
- **Brawler pages and cards**: win / picked / banned, best build, best modes and maps, best
  teammates. Tap any brawler's name or picture for a quick card.
- **Your player tag** (saved on the device only): Curated pick ranks *your* brawlers for each
  map, and build icons show what you own.
- **Upgrades**: type in your power points and coins; get the upgrades that help you most in
  Ranked, with a short reason for each.
- **Balance changes**: the last 14 days of buffs, nerfs and reworks, split into Major and Minor,
  with Supercell's reason for each. Rankings for a changed brawler restart from the change.

## How it works

```
GitHub Actions (daily.yml)            Cloudflare Worker (worker/)          GitHub Pages (site/)
  every 30 min: rotation                /player/:tag  -> your brawlers        static HTML/CSS/JS
  every 3 h: stats, builds, combos      /rotation     -> live timers   <-->   reads data/*.json
  -> data branch -> deploy site/        cron every 3 h -> starts the stats job  + calls the Worker
```

- **Site** (`site/`): plain HTML/CSS/JS, no build step, no framework. Data is two preloaded
  JSON files plus self-hosted images, so pages open instantly.
- **Data job** (`.github/workflows/daily.yml`, `scripts/`): pulls from the official Brawl Stars
  API through the RoyaleAPI proxy (`bsproxy.royaleapi.dev`, fixed IP 45.79.218.79), writes
  `site/data/` and `site/img/`, and deploys. Generated files live on the **`data` branch** (one
  commit, replaced each run), so `main` holds only code.
- **Worker** (`worker/`, Cloudflare free plan): keeps the API key out of the browser for player
  lookups, serves live rotation, and starts the stats job on time every 3 hours (GitHub's own
  scheduler runs late). If the Worker is down, the site keeps working on its static files.

## Data and ranking

- **High-skill games only.** In Ranked battle logs, `brawler.trophies` is the player's rank
  (16+ Legendary, 19+ Masters). The job reads the top players in 8 regions, crawls up to 3,000
  Legendary+ players met in their Ranked games, and keeps Ranked games plus trophy games where
  every brawler has 750+ trophies. Draws, friendlies and Showdown are dropped. Window: last 14 days.
- **Score** = estimated win rate on that map, corrected for two biases:
  - *skill*: top players' side wins most games, so each brawler is compared with how often its
    side usually won on that map;
  - *luck*: results are pulled toward 50% with weight fitted from the data (few games count less),
    starting from how often good players pick or ban the brawler there.
- **Best build**: the official API never says what was equipped. A skilled player who owns only
  one of a brawler's star powers or gadgets chose it first, and owning exactly two gears means
  those are the pair. Counted over thousands of Legendary+ profiles; close calls are flagged.
- **Curated pick / Upgrades**: map score minus what each missing piece costs (power, star power,
  gadget, gears, hypercharge, buffies). Costs are measured from Ranked games by comparing each
  player's games with and without the piece. Until 20,000 games are measured, fixed estimates
  are used. Buffies only count for brawlers that have them in the game (`data.buffies`).
- **Combos**: same-team duos and trios, adjusted the same way, plus how much better they do
  together than apart.
- **Balance changes**: read once a day from Supercell's release notes (first) and each brawler's
  balance history on [Liquipedia](https://liquipedia.net/brawlstars/) (CC BY-SA), which can lag a
  patch. Rule-based: a rework, a new brawler or 3+ changes is *major*, 1-2 is *minor*; each line is
  a buff or a nerf from its wording. A brawler changed in the last 14 days only counts games after
  the change (the patch day is dropped too), and is left out of the picks until it has 3 days of
  fresh games: steady data over a guess. Saved in `data/balance.json`.
- **Images**: [Brawlify CDN](https://github.com/Brawlify/CDN), downloaded once and shrunk to the
  size the site shows them.

If a pull fails, the previous data stays up and the run is marked failed.

## Setup (done)

| What | Where |
|---|---|
| Brawl Stars API key allowing IP 45.79.218.79 | repo secret `BS_API_KEY`, Worker secret `BS_API_KEY` |
| Pages source: GitHub Actions | repo settings |
| Worker `brawl-picks-api` + cron `17 */3 * * *` | Cloudflare, see `worker/README.md` |
| GitHub token for the Worker cron (Actions: read and write, this repo only) | Worker secret `GH_TOKEN` |
| Worker URL | `site/config.js` (`API_BASE`) |

## Local development

Node 22+, no dependencies.

```bash
npm run pull-data  # copy the live data (data branch) into site/
npm run dev        # serve site/ at http://localhost:5173
npm test           # unit + pipeline tests (mock API) + Worker tests
npm run demo       # made-up data, no key needed
npm run data       # real stats pull (needs BS_API_KEY)
```

**Check every UI change** with the UX check: it walks every flow in a real browser (phone, 320 px,
desktop) and fails on accessibility issues (WCAG 2.2 AA), small touch targets, broken dialogs,
broken back navigation, sideways scrolling or JavaScript errors.

```bash
cd tools/ux-check && npm install && cd ../..
npm run ux-check
```

## Layout

```
site/           the website (deployed as-is)
  app.js          UI and routing        search.js   map + brawler search
  curate.js       Curated pick          advisor.js  Upgrades
  modes.js        mode names/colours    config.js   Worker URL
scripts/        data job: fetch-data, fetch-rotation, builds (best builds, piece costs), balance,
                data-branch.sh, shrink-images, score-lab (score validation), serve, demo-data
worker/         Cloudflare Worker (player lookup, live rotation, cron)
tools/ux-check/ browser UX check
test/           node:test suites
data/           per-day counts, on the data branch
docs/           Cloudflare setup handoff notes (history)
prototype/      the first clickable prototype
```

`scripts/ranked-maps.json` lists the current Ranked maps; update it when the season rotates
(maps are also tagged Ranked once Ranked games are seen on them).

Not affiliated with, endorsed, sponsored or specifically approved by Supercell. Supercell is not
responsible for it.
