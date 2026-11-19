# Brawl Picks

Best Brawl Stars brawlers for every map. Type a map's initials (`hrm` → Hard Rock Mine), hit Enter, see the top 5.

- **Static site** (`site/`): plain HTML/CSS/JS, no build step. All data is one preloaded JSON file (`site/data/data.json`), so opening a map is instant.
- **Daily data job** (`.github/workflows/daily.yml`): GitHub Actions runs `scripts/fetch-data.mjs` every day at 09:17 UTC, commits the new `data.json`, and deploys `site/` to GitHub Pages.

## Status / handoff

| | |
|---|---|
| Site, search, map view | Done; tested with demo data in a headless browser |
| Daily workflow | Written; first run failed (Pages off, no API key) |
| Data pull (`fetch-data.mjs`) | Rewritten to use the official API; passes mock tests, **not yet run against the real APIs** |
| Live site | Not yet. Needs the setup below |

**To-do to go live:**
1. Enable Pages with Actions as the source: `gh api repos/BlakeHan01/brawl-picks/pages -X POST -f build_type=workflow`
2. Add the API key secret: `gh secret set BS_API_KEY` (see "Data sources" for how to get a key)
3. Test locally: `BS_API_KEY=... npm run data`, then `npm run dev`. Check map count, brawler names and images.
4. Trigger and watch the workflow: `gh workflow run daily.yml && gh run watch`
5. Fix anything that breaks against the real API response shapes, keep `npm test` passing.

**Unverified assumptions to check on the first real run:**
- Image URLs `https://cdn.brawlify.com/brawlers/borderless/{id}.png` and `/maps/regular/{id}.png`
- Battle-log fields used: `event.{id,mode,map}`, `battle.{type,result,teams[][].{tag,brawler.id}}`
- The ranking regions in `BS_REGIONS` all exist

## Data sources

**Primary: official Brawl Stars API.** You need a key from https://developer.brawlstars.com. The script samples the battle logs of top players (global plus several regions), keeps 3v3 games (Gem Grab, Brawl Ball, Heist, Bounty, Knockout, Hot Zone), removes duplicate games, and computes win rate per brawler per map.

- Requests go through the RoyaleAPI proxy (`bsproxy.royaleapi.dev`) because GitHub runner IPs change. When creating the key, set its allowed IP to **45.79.218.79**.
- Settings come from environment variables: `BS_API_KEY`, `BS_API_BASE`, `BS_PLAYER_LIMIT` (default 200 per region), `BS_REGIONS` (default `global,us,kr,br,de,jp`).

**Optional: Brawlify** (`api.brawlapi.com`). Used for map art, mode colours and active-event flags when it's reachable. It returns 403 to GitHub Actions runners and its per-map stats are currently empty, so the site works without it. Set `BRAWLIFY_BASE=off` to skip it.

If a daily pull fails or returns fewer than 5 maps, `data.json` is not overwritten. The site keeps serving the last good data and the run is marked failed.

## How picks are ranked

Picks are sorted by an **adjusted win rate**: wins shrunk toward 50% with a prior of 20 games, `(wins + 10) / (games + 20)`. This stops a brawler with 70% over a handful of games from outranking a proven pick. The page shows the raw win rate and use rate. Maps with fewer than 15 sampled battles are skipped.

## Ranked map pool

`scripts/ranked-maps.json` lists the current ranked maps, used for the "Ranked" tag, the filter, and search ordering. Maps also get tagged if sampled battles had a ranked battle type. Update the list when the season rotates.

## Project layout

```
site/            static site (deployed as-is)
  index.html, style.css, app.js
  search.js      initials search (shared with tests)
  data/data.json generated daily — do not edit by hand
scripts/
  fetch-data.mjs daily data pull
  ranked-maps.json
  serve.mjs      zero-dependency local server
test/            node:test — search + pipeline (runs against a mock API)
```

## Local dev

No dependencies to install (Node 20+).

```bash
npm run data   # pull data into site/data/data.json (needs BS_API_KEY)
npm run dev    # http://localhost:5173
npm test       # search + pipeline tests
```

## Next: step 2 (personalized picks)

The user enters their player tag, the official API returns their brawlers, power levels, gears, star powers and gadgets, and each map's picks are re-ranked by what they actually own and how built-up it is. Later: real sign-up and account linking.

Not affiliated with or endorsed by Supercell.
