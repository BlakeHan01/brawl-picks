# Handoff: deploy the Brawl Picks Cloudflare Worker

**Status: done.** Deployed at https://brawl-picks-api.hanyufei2001.workers.dev (see `docs/HANDOFF-worker-deployed.md`). The deployed code is Muse's version from PR #4, now in `worker/`.

**For:** Muse (setup and deploy only). **Site integration:** Claude.

## What it is (no action needed)

A small Cloudflare Worker that the website calls:

- `GET /player/:tag`: looks up a player's brawlers with the official Brawl Stars API, for "Curated pick". The API key stays on Cloudflare, never in the browser.
- `GET /rotation`: the current map rotation, live (cached 2 minutes), so the site's timers stop depending on GitHub's late schedule.
- A cron trigger every 3 hours that asks GitHub to run the stats workflow on time.

The code is tested: unit tests, a `wrangler deploy --dry-run` build, and a run in Cloudflare's local runtime (`wrangler dev`) against a fake API.

## Your scope

**Do:** the steps below. **Don't:** write or change code, run the repo's scripts or tests, or touch GitHub branches or PRs. Everything must stay on the **free plan**: no credit card, no paid add-ons.

### 1. Cloudflare account (free)

Sign up at https://dash.cloudflare.com/sign-up. The free plan is the default; skip any upgrade offers.

### 2. GitHub token (for the cron trigger)

GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token:

- Repository access: **Only select repositories** → `BlakeHan01/brawl-picks`
- Permissions → Repository permissions → **Actions: Read and write** (leave everything else at "No access")
- Expiration: your choice (when it expires, the cron stops starting runs; GitHub's own schedule still runs as a backup)

Copy the token; it's shown once.

### 3. Deploy

You need Node 20+ installed. From a checkout of the repo (branch `claude/zen-dirac-331sre` until it's merged, then `main`):

```bash
cd worker
npx wrangler login                    # opens the browser; approve access
npx wrangler deploy                   # creates "brawl-picks-api"; prints its URL
npx wrangler secret put BS_API_KEY    # paste the Brawl Stars API key
npx wrangler secret put GH_TOKEN      # paste the GitHub token from step 2
```

- **BS_API_KEY** is the same key as the repo's GitHub secret `BS_API_KEY`. It lives at developer.brawlstars.com → My Account → key `brawl-picks` (allowed IP 45.79.218.79; leave that as is).
- Secrets take effect right away; no redeploy needed.

### 4. Check it (browser is fine)

Replace `<url>` with the URL `wrangler deploy` printed (like `https://brawl-picks-api.<name>.workers.dev`):

- [ ] `<url>/rotation` shows a list of current maps (`"events": [...]`).
- [ ] `<url>/player/<your tag without #>` shows your name and brawlers.
- [ ] `<url>/player/abc` shows `{"error":"bad_tag"}`.
- [ ] Within 3 hours, GitHub → Actions → "Data + deploy" shows a run triggered by `workflow_dispatch` at :17 past the hour.

If `/player/...` shows `{"error":"upstream_auth"}`, the Brawl Stars key is wrong or its allowed IP isn't 45.79.218.79.

### 5. Send back

The Worker URL. Claude plugs it into the site (`site/config.js`) and tests it end to end.

## Reference (no action needed)

- Settings live in `worker/wrangler.toml`: Worker name `brawl-picks-api`, upstream `https://bsproxy.royaleapi.dev/v1` (RoyaleAPI proxy with fixed IP), allowed sites `https://blakehan01.github.io` and `http://localhost:5173`, cron `17 */3 * * *`.
- Free-plan fit: 100,000 requests/day (responses are cached 60–120 s), under 10 ms CPU per request, one cron, one upstream call per request. If a limit is ever hit, the free plan rejects requests instead of billing; the site falls back to its static files.
- Response shapes: `GET /player/:tag` → `{ tag, name, trophies, fetchedAt, brawlers: [{ id, power, trophies, rank, starPowers: [ids], gadgets: [ids], gears: [ids], hyperCharges: [ids], buffies? }] }`; `GET /rotation` → `{ fetchedAt, events: [{ slot, id, map, modeId, start, end, modifiers }] }`. Errors: `400 bad_tag`, `404 not_found`, `502 upstream_auth|upstream`, `503 busy`.
