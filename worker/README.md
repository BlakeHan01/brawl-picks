# brawl-picks-api (Cloudflare Worker)

Free plan only. No KV, D1, Durable Objects, or paid add-ons.

## Endpoints

- `GET /player/:tag` — owned brawlers for one player. Tag may come with or
  without `#`, any case; `O` is treated as `0`. Returns only tag, name,
  trophies, `fetchedAt`, and per-brawler id/power/trophies/rank plus id-only
  star powers, gadgets, gears, hypercharges (and `buffies` when present).
  Cached 60 s. Bad tag → `400 {"error":"bad_tag"}`, unknown player → 404.
- `GET /rotation` — current event rotation, live from the Brawl Stars API.
  Cached 120 s.

CORS allows only `https://blakehan01.github.io` and `http://localhost:5173`.
Unknown paths → `404 {"error":"not_found"}`.

## Cron

Every 3 hours at :17 UTC the Worker dispatches the GitHub Actions
`daily.yml` workflow (`workflow_dispatch`, `stats: true`) so the stats run
starts on time. GitHub's own schedule stays as a backup; the workflow's
`concurrency` group prevents overlap.

## Tests

```bash
node --test "worker/**/*.test.mjs"
# (plain `node --test worker/` does not discover the nested test file on Node 24)
```

No dependencies, no network in tests (upstream `fetch` is stubbed).

## Deploy

```bash
cd worker
npx wrangler login          # or CLOUDFLARE_API_TOKEN with the "Edit Cloudflare Workers" template
npx wrangler deploy         # name: brawl-picks-api
npx wrangler secret put BS_API_KEY
npx wrangler secret put GH_TOKEN
```

Secrets (Worker → Settings → Variables and Secrets):

| Name | What |
| --- | --- |
| `BS_API_KEY` | Brawl Stars API token, same as the GitHub secret `BS_API_KEY` (key `brawl-picks`, allowed IP 45.79.218.79) |
| `GH_TOKEN` | Fine-grained GitHub token, repo `BlakeHan01/brawl-picks` only, permission **Actions: Read and write** |

Resulting URL looks like `https://brawl-picks-api.<account-subdomain>.workers.dev`.
That goes into the site config (`site/config.js`, `API_BASE`).
