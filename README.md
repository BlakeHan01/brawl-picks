# Brawl Picks

Best Brawl Stars brawlers for every map. Type a map's initials (`hrm` → Hard Rock Mine), hit Enter, see the top 5.

- **Static site** (`site/`) — plain HTML/CSS/JS, no build step. All data is one preloaded JSON file, so opening a map is instant.
- **Daily data job** (`.github/workflows/daily.yml`) — GitHub Actions runs `scripts/fetch-data.mjs` every day, commits `site/data/data.json`, and deploys to GitHub Pages.

## Setup (about 2 minutes)

1. Create the repo and push:
   ```bash
   cd brawl-picks
   gh repo create brawl-picks --public --source . --push
   ```
2. On GitHub: **Settings → Pages → Source: GitHub Actions**.
3. **Actions → Daily data + deploy → Run workflow**. When it finishes, the site is at `https://<you>.github.io/brawl-picks/`.

### Optional: official API as a second data source

The job first uses Brawlify's public API (no key). If Brawlify has no win-rate stats for some maps, it can compute them itself from top players' battle logs via the official API:

1. Make a key at https://developer.brawlstars.com with allowed IP **45.79.218.79** (the RoyaleAPI proxy, since GitHub's IPs change).
2. Add it as a repo secret named `BS_API_KEY` (Settings → Secrets and variables → Actions).

If a daily pull fails, the site keeps serving the last good data and the run is marked failed so you notice.

## Local dev

```bash
npm run data   # pull data into site/data/data.json (needs internet)
npm run dev    # http://localhost:5173
npm test       # search + pipeline tests (pipeline runs against a mock API)
```

## How picks are ranked

Each map's brawlers are sorted by an **adjusted win rate**: raw win rate shrunk toward the map average, weighted by how often the brawler is picked, so a brawler with 70% over a handful of games doesn't outrank a proven pick. With official-API data, real game counts are used (Bayesian prior of 20 games at 50%).

## Ranked map pool

`scripts/ranked-maps.json` lists the current ranked maps (used for the "Ranked" tag, the filter, and search ordering). Update it when the season rotates.

## Next (step 2)

User accounts + player tag → pull their brawlers, power levels, gears, star powers and gadgets from the official API → re-rank each map's picks by what they actually own.

Not affiliated with or endorsed by Supercell.
