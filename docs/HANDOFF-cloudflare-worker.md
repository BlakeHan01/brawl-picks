# Handoff: Cloudflare Worker for Brawl Picks

**Owner:** Muse · **Site-side integration:** Claude (builds against the contract below) · **Repo:** `BlakeHan01/brawl-picks`

## Why

1. **Player lookup for "Curated pick".** The site recommends each user's top 5 brawlers per map from the brawlers *they* own. That needs the official Brawl Stars API, whose key must never be in the browser. The Worker holds the key and returns only brawler data.
2. **Fresh map timers.** The site's rotation file is refreshed by a GitHub Actions schedule, which GitHub runs late or skips. On 2026-11-20 it went 3+ hours without a run, so 4 of 13 "live" events had already ended on the site. The Worker serves the rotation live (cached briefly) instead.
3. **Reliable stats runs.** The stats crawl (~30k API calls, ~5 min) stays on GitHub Actions, but a Cloudflare Cron Trigger starts it on time via the GitHub API. GitHub's own schedule stays as a backup.

## What to build

Put the code in `worker/` in this repo (`worker/src/index.js`, `worker/wrangler.toml`, tests). Plain JS, no framework needed.

### Upstream API

- Base: `https://bsproxy.royaleapi.dev/v1` (RoyaleAPI proxy, fixed IP **45.79.218.79**; the existing key already allows only that IP, so the same key works from Cloudflare).
- Header: `Authorization: Bearer <BS_API_KEY>`.
- Tags in paths are URL-encoded with the `#`: `/players/%23ABC123`.

### Endpoint 1: `GET /player/:tag`

`:tag` may come with or without `#`, any case. Normalize: strip `#`, uppercase, replace letter `O` with digit `0`. Valid if it matches `^[0289PYLQGRJCUV]{3,12}$`, else `400 {"error":"bad_tag"}`.

Calls `GET /players/%23{TAG}` and returns **only** this (drop everything else, e.g. club, icons, skins):

```json
{
  "tag": "#ABC123",
  "name": "PlayerName",
  "trophies": 52341,
  "fetchedAt": "2026-11-20T22:00:00.000Z",
  "brawlers": [
    {
      "id": 16000000,
      "power": 11,
      "trophies": 1200,
      "rank": 25,
      "starPowers": [23000076, 23000135],
      "gadgets": [23000255],
      "gears": [62000002, 62000004],
      "hyperCharges": [23000613],
      "buffies": { "gadget": true, "starPower": false, "hyperCharge": false }
    }
  ]
}
```

- `starPowers` / `gadgets` / `gears` / `hyperCharges`: arrays of **ids** only (upstream objects have `{id, name, level?}`).
- `buffies`: pass through if present; omit the key if upstream has none.
- Errors: upstream 404 → `404 {"error":"not_found"}`; upstream 403 → `502 {"error":"upstream_auth"}` (key/IP problem: log it); upstream 429/503 → `503 {"error":"busy"}` with `Retry-After: 30`; anything else → `502 {"error":"upstream"}`.
- Cache successful responses for **60 s** (Cache API, keyed by normalized tag).

### Endpoint 2: `GET /rotation`

Calls `GET /events/rotation` and returns:

```json
{
  "fetchedAt": "2026-11-20T22:00:00.000Z",
  "events": [
    { "slot": 1, "id": 15000007, "map": "Hard Rock Mine", "modeId": "gemGrab", "start": "2026-11-20T08:00:00.000Z", "end": "2026-11-21T08:00:00.000Z", "modifiers": [] }
  ]
}
```

- Upstream times look like `20261120T080000.000Z`; convert to ISO 8601 (see `parseTime` in `scripts/lib.mjs`).
- Map `slotId → slot`, `event.id → id`, `event.map → map`, `event.mode → modeId`, `event.modifiers → modifiers` (default `[]`). Drop events without a map or end time. Sort by `slot`.
- Same logic as `parseRotation` in `scripts/fetch-rotation.mjs`, minus the display fields (`mode`, `modeColor`, `solo`, `img`): the site adds those.
- Cache **120 s**.

### Common to both

- **CORS:** `Access-Control-Allow-Origin` for `https://blakehan01.github.io` and `http://localhost:5173` (local dev); reflect the request `Origin` if it's one of these. Handle `OPTIONS` preflight. `GET` only.
- `Content-Type: application/json; charset=utf-8`, `Cache-Control: public, max-age=60` (player) / `max-age=120` (rotation).
- Unknown paths → `404 {"error":"not_found"}`.
- Never log or echo the API key or full upstream responses.
- Optional but good: a Cloudflare rate-limiting rule, e.g. 30 requests/minute per IP on `/player/*`.

### Cron Trigger: start the stats run on time

- Schedule: `17 */3 * * *` (every 3 hours at :17 UTC).
- Handler: `POST https://api.github.com/repos/BlakeHan01/brawl-picks/actions/workflows/daily.yml/dispatches` with headers `Authorization: Bearer <GH_TOKEN>`, `Accept: application/vnd.github+json`, `User-Agent: brawl-picks-worker`, and body `{"ref":"main","inputs":{"stats":"true"}}`. Expect `204`. Log failures.
- The workflow already has a `concurrency` group, so a run started here and one from GitHub's schedule won't overlap.

## Secrets (Worker → Settings → Variables and Secrets)

| Name | What | Where to get it |
|---|---|---|
| `BS_API_KEY` | Brawl Stars API token (same one as the GitHub secret `BS_API_KEY`) | developer.brawlstars.com → My Account → the `brawl-picks` key (allowed IP 45.79.218.79) |
| `GH_TOKEN` | Fine-grained GitHub token, repo `BlakeHan01/brawl-picks` only, permission **Actions: Read and write** | github.com → Settings → Developer settings → Fine-grained tokens |

## Deploy

```bash
cd worker
npx wrangler login          # or CLOUDFLARE_API_TOKEN with the "Edit Cloudflare Workers" template
npx wrangler deploy         # name: brawl-picks-api
npx wrangler secret put BS_API_KEY
npx wrangler secret put GH_TOKEN
```

Resulting URL looks like `https://brawl-picks-api.<account-subdomain>.workers.dev`. **Send that URL to Claude**: it goes into the site config (`site/config.js`, `API_BASE`).

## Done when

- [ ] `curl https://<worker>/rotation` returns current events, all with `end` in the future, and `fetchedAt` within the last 2 minutes on a second call.
- [ ] `curl https://<worker>/player/%23<your tag>` returns your brawlers in the shape above; a made-up tag returns 404; `abc!` returns 400.
- [ ] From `https://blakehan01.github.io`, the browser console shows no CORS errors for both endpoints (`fetch('https://<worker>/rotation').then(r=>r.json())`).
- [ ] The cron trigger fires: a "Data + deploy" run appears in GitHub Actions with event `workflow_dispatch` at :17 past a 3-hour mark.
- [ ] No secrets in the repo; `worker/` has a test for tag normalization and the rotation time conversion.

## What the site does with it (Claude's side, for reference)

- Reads `API_BASE` from `site/config.js`. If it's empty or the Worker fails, the site keeps working: timers fall back to `data/rotation.json`, and Curated pick shows "player lookup unavailable".
- Rotation: fetched live on load and every few minutes; merged with the static file for mode names, colours and map images.
- Curated pick: the user enters their tag once (stored on their device), the site calls `/player/:tag`, then ranks *their* brawlers per map by our score, preferring fully built ones (power 11, the recommended star power and gadget, gears, hypercharge, buffies). It shows the top 5 and what each is missing.
