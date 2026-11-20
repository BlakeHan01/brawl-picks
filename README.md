# Brawl Picks

Best Brawl Stars brawlers for every map. Type a map's initials (`hrm` → Hard Rock Mine), hit Enter, see the top 5. A "Live now" strip shows the current rotation, specialty events included, with accurate time left.

- **Static site** (`site/`): plain HTML/CSS/JS, no build step. Data is two preloaded JSON files plus self-hosted images, so opening a map is instant.
- **Data job** (`.github/workflows/daily.yml`) on GitHub Actions:
  - every 30 min: event rotation → `site/data/rotation.json`
  - every 3 hours: brawler stats → `site/data/data.json`
  - commits what changed and redeploys `site/` to GitHub Pages.

## Status

| | |
|---|---|
| Site UI | Done; checked with real data at desktop and phone width |
| Pipeline + rotation scripts | Done; running against the real API since 2026-11-20 |
| Setup (key, secret, Pages) | Done |
| Stats window | Fills up over the first 14 days; until then some picks rest on few games |

**One-time setup (done):** an API key from https://developer.brawlstars.com allowing IP **45.79.218.79** (RoyaleAPI proxy), stored as the repo secret **`BS_API_KEY`**; Pages source set to **GitHub Actions**. If the key is ever replaced, update the secret.

Confirmed on the first real run: Ranked games have `battle.type` `soloRanked`/`teamRanked` and trophy games `ranked`; battle-log players carry `brawler.trophies`; `/events/rotation` returns `startTime`/`endTime` like `20261120T080000.000Z`. Map names come without apostrophes (`Belles Rock`), so name matching ignores punctuation.

## Data sources and why

**Stats: official Brawl Stars API, high-skill games only.** In Ranked battle logs each player's `brawler.trophies` holds their Ranked rank (1–22: 16+ Legendary, 19+ Masters, 22 Pro), checked on real data. The job reads the top players in each region, then crawls up to `CRAWL_LIMIT` (3000) Legendary+ players met in their Ranked games, and records every Ranked game as all-Ranked, Legendary+ (every player 16+) and Masters+ (19+).

**Shadow run (new ranking, shown as "New ranking" on map pages):** Masters+ games once a map has 150, else Legendary+ from 40; the shrink prior is not flat 50% but leans on how often those players pick each brawler (2 points per e-fold of pick rate vs. the map median, capped). The current ranking stays available until we switch.

Earlier notes on the current ranking: Win rates from low-trophy lobbies (often bots) or casual players are misleading, so the daily job:
1. reads the battle logs of the top `BS_PLAYER_LIMIT` (200) players in each region of `BS_REGIONS` (`global,us,kr,br,de,jp,mx,fr`);
2. keeps **Ranked** games, plus **trophy** games where *every* player's brawler has `MIN_TROPHIES` (750)+ trophies; friendly/challenge games, draws and showdown are dropped;
3. de-duplicates games seen from several players and only counts games newer than the previous run;
4. saves the day's counts to `data/daily/<date>.json` and combines the last `WINDOW_DAYS` (14).

Per map, picks use Ranked games only once a map has 40+ of them; otherwise Ranked and high-trophy games together (specialty maps are usually trophy-only). The site states which on each map, and labels maps with under 150 games as "few games". Maps under 15 games get no picks.

**Ranking.** Raw win rates from top players' logs are inflated: their side wins about 57% of Ranked and 69% of trophy games in our sample, so whatever they pick looks strong. Two corrections:
1. *Skill:* each brawler is compared with how often its side won on that map, counted on both sides. `excess = (wins on top side − games × p) + (wins on other side − games × (1 − p))`, where `p` is the top side's win rate on the map.
2. *Luck:* the estimate is shrunk toward 50% as if every brawler had 40 extra games at 50%: `win% = 50 + 100 × excess / (games + 40)`. Brawlers under 10 games are hidden.

The page shows this estimate (50% = average pick), pick rate and game count, and ranks by the estimate.

**Rotation timers: official `/events/rotation`.** These are the game's own start/end times; the browser counts down from `endTime`. The file refreshes every 30 minutes, so after a slot ends its next map appears within about half an hour ("Next map soon" until then).

**Images: [Brawlify CDN](https://github.com/Brawlify/CDN)**, keyed by official IDs, downloaded once into `site/img/` and served from the site. Brawlify's *API* blocks some datacenter IPs, so it isn't used.

**Requests go through the RoyaleAPI proxy** (`bsproxy.royaleapi.dev`) because GitHub runner IPs change; the key only needs to allow the proxy's IP.

**Where the data lives.** Everything the job generates is on the `data` branch, which always holds one commit: `scripts/data-branch.sh restore` puts it in the working tree before the pulls and `save` replaces the branch afterwards. main only holds code, so its history doesn't grow with every update.

If a pull fails, the previous files stay in place and the run is marked failed. The stats job also refuses to publish fewer than 5 maps.

**Planned:** a weekly cross-check of our top 5s against Brawl Time Ninja's Ranked list and Masters-level tier lists, flagging big disagreements for review.

## Ranked map pool

`scripts/ranked-maps.json` lists the current ranked maps. A map is also tagged Ranked once Ranked games are seen on it. Update the list when the season rotates.

## Project layout

```
site/              static site (deployed as-is)
  index.html, style.css, app.js, search.js
  data/            data.json, rotation.json   } generated: stored on the `data` branch,
  img/             brawler + map images       } git-ignored on main
data/              per-day game counts (last 14 days), state, brawler classes: also on `data`
scripts/
  fetch-data.mjs   daily stats pull
  fetch-rotation.mjs
  lib.mjs          shared helpers, mode names/colours, image download
  demo-data.mjs    sample data for local UI work (.demo/, git-ignored)
  serve.mjs        zero-dependency local server
prototype/         clickable UI prototype on made-up data (includes the step-2 preview)
test/              node:test: pipeline (mock API) + search
```

## Local dev

No dependencies (Node 22+).

```bash
npm run demo       # sample data + server at http://localhost:5173 (no key needed)
npm run pull-data  # copy the live data (data branch) into your checkout
npm run data       # real stats  (needs BS_API_KEY)
npm run rotation   # real rotation (needs BS_API_KEY)
npm run dev        # serve site/ with whatever data it has
npm test
```

Behind an HTTPS proxy, run the data scripts with `NODE_USE_ENV_PROXY=1`.

## Next: step 2 (personalized picks)

The user enters their player tag, the official API returns their brawlers, power levels, gears, star powers and gadgets, and each map's picks are re-ranked by what they own ("Best for me", previewed in `prototype/`). This needs a small server or edge function, since the API key can't be in the browser.

Not affiliated with, endorsed, sponsored or specifically approved by Supercell. Supercell is not responsible for it.
