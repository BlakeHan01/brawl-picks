# Brawl Picks

Best Brawl Stars brawlers for every map. Type a map's initials (`hrm` → Hard Rock Mine), hit Enter, see the top 5. A "Live now" strip shows the current rotation, specialty events included, with accurate time left.

- **Static site** (`site/`): plain HTML/CSS/JS, no build step. Data is two preloaded JSON files plus self-hosted images, so opening a map is instant.
- **Data job** (`.github/workflows/daily.yml`) on GitHub Actions:
  - every 30 min: event rotation → `site/data/rotation.json`
  - daily at 09:17 UTC: brawler stats → `site/data/data.json`
  - commits what changed and redeploys `site/` to GitHub Pages.

## Status

| | |
|---|---|
| Site UI | Done; checked on sample data (`npm run demo`) at desktop and phone width |
| Pipeline + rotation scripts | Done; pass tests against a mock API, **not yet run against the real API** |
| Live site | Needs the one-time setup below |

**One-time setup (repo owner):**
1. Create an API key at https://developer.brawlstars.com with allowed IP **45.79.218.79** (RoyaleAPI proxy, see below).
2. Repo Settings → Secrets and variables → Actions → new secret **`BS_API_KEY`**.
3. Repo Settings → Pages → Source: **GitHub Actions**.
4. Merge to `main`. The push runs the workflow once, then the schedules take over.

**Check on the first real run** (field names come from community docs):
- Ranked games have `battle.type` `soloRanked` / `teamRanked`; trophy games have `ranked`.
- Battle-log players carry `brawler.trophies` (used for the high-trophy filter).
- `/events/rotation` returns `startTime`/`endTime` as `20261120T080000.000Z`, with `event.id/mode/map`.

## Data sources and why

**Stats: official Brawl Stars API, high-skill games only.** Win rates from low-trophy lobbies (often bots) or casual players are misleading, so the daily job:
1. reads the battle logs of the top `BS_PLAYER_LIMIT` (200) players in each region of `BS_REGIONS` (`global,us,kr,br,de,jp,mx,fr`);
2. keeps **Ranked** games, plus **trophy** games where *every* player's brawler has `MIN_TROPHIES` (750)+ trophies; friendly/challenge games, draws and showdown are dropped;
3. de-duplicates games seen from several players and only counts games newer than the previous run;
4. saves the day's counts to `data/daily/<date>.json` and combines the last `WINDOW_DAYS` (14).

Per map, picks use Ranked games only once a map has 40+ of them; otherwise Ranked and high-trophy games together (specialty maps are usually trophy-only). The site states which on each map, and labels maps with under 150 games as "few games". Maps under 15 games get no picks.

**Ranking:** adjusted win rate `(wins + 10) / (games + 20)`, which pulls brawlers with few games toward 50%. Brawlers under 5 games are hidden. The page shows raw win rate, pick rate and game count.

**Rotation timers: official `/events/rotation`.** These are the game's own start/end times; the browser counts down from `endTime`. The file refreshes every 30 minutes, so after a slot ends its next map appears within about half an hour ("Next map soon" until then).

**Images: [Brawlify CDN](https://github.com/Brawlify/CDN)**, keyed by official IDs, downloaded once into `site/img/` and served from the site. Brawlify's *API* blocks datacenter IPs (including GitHub Actions), so it isn't used.

**Requests go through the RoyaleAPI proxy** (`bsproxy.royaleapi.dev`) because GitHub runner IPs change; the key only needs to allow the proxy's IP.

If a pull fails, the previous files stay in place and the run is marked failed. The stats job also refuses to publish fewer than 5 maps.

**Planned:** a weekly cross-check of our top 5s against Brawl Time Ninja's Ranked list and Masters-level tier lists, flagging big disagreements for review.

## Ranked map pool

`scripts/ranked-maps.json` lists the current ranked maps. A map is also tagged Ranked once Ranked games are seen on it. Update the list when the season rotates.

## Project layout

```
site/              static site (deployed as-is)
  index.html, style.css, app.js, search.js
  data/            data.json (daily), rotation.json (every 30 min): generated, don't edit
  img/             brawler + map images (downloaded by the jobs)
data/daily/        per-day game counts, last 14 days (not deployed)
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
npm run data       # real stats  (needs BS_API_KEY)
npm run rotation   # real rotation (needs BS_API_KEY)
npm run dev        # serve site/ with whatever data it has
npm test
```

Behind an HTTPS proxy, run the data scripts with `NODE_USE_ENV_PROXY=1`.

## Next: step 2 (personalized picks)

The user enters their player tag, the official API returns their brawlers, power levels, gears, star powers and gadgets, and each map's picks are re-ranked by what they own ("Best for me", previewed in `prototype/`). This needs a small server or edge function, since the API key can't be in the browser.

Not affiliated with, endorsed, sponsored or specifically approved by Supercell. Supercell is not responsible for it.
