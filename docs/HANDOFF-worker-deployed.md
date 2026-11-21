# Handoff: Cloudflare Worker DEPLOYED — for Claude (site integration)

**Date:** 2026-11-20, ~19:54 PST · **From:** Muse · **To:** Claude · **Repo:** `BlakeHan01/brawl-picks` · **PR:** #4 (`claude/cloudflare-worker` → `claude/zen-dirac-331sre`)

## The one thing you need

```js
API_BASE = "https://brawl-picks-api.hanyufei2001.workers.dev"
```

Put it in `site/config.js` as `API_BASE` (create that file if it doesn't exist yet — there is no `site/config.js` on the branch as of this handoff). The site reads `API_BASE` from there; if it's empty or the Worker fails, the site keeps working on its static files, per the original handoff.

## What was deployed

- Worker name: `brawl-picks-api`
- URL: https://brawl-picks-api.hanyufei2001.workers.dev
- Account workers.dev subdomain: `hanyufei2001`
- Version ID: `b8618dc9-de41-4680-a3b5-61304eb884a8`
- Code: `worker/` on branch `claude/cloudflare-worker` (commit 21744af + this handoff doc). Self-contained, no imports from `scripts/`. Free plan only, no KV/D1/Durable Objects.
- Deploy method: `npx wrangler deploy` from `worker/` (wrangler 4.166.0), with a Cloudflare API token from the "Edit Cloudflare Workers" template (token name `brawl-picks`).
- Cron: `17 */3 * * *` (UTC) — dispatches `daily.yml` via GitHub API. Confirmed in the deployed Worker: `schedule: 17 */3 * * *`.

## Secrets — both set, do not re-create

- `BS_API_KEY`: set via `wrangler secret put`. Same key as the GitHub repo secret — the `brawl-picks` key from developer.brawlstars.com, allowed IP 45.79.218.79.
- `GH_TOKEN`: set via `wrangler secret put`. Fine-grained token named `brawl-picks-worker`, created 2026-11-20, **no expiration**, resource owner BlakeHan01, repository access only `BlakeHan01/brawl-picks`, permissions Actions: Read and write (+ mandatory Metadata: Read-only, automatic).
- No secret values are in the repo, in this file, or in any commit. Do not paste them into code, docs, or chat.

## Verified live (2026-11-21 03:54 UTC / 2026-11-20 19:54 PST)

- `GET /rotation` → 200, live events, all `end` in the future. Second call ~1s later returned a fresh `fetchedAt` (03:54:26Z → 03:54:27Z). Example event: slot 1, Brawl Ball, "Bustling Business", end 2026-11-21T08:00:00Z.
- `GET /player/%23PPPPPPPP` → 404 `{"error":"not_found"}` (made-up tag).
- `GET /player/%23abc!` → 400 `{"error":"bad_tag"}`.
- CORS: `Access-Control-Allow-Origin: https://blakehan01.github.io` present on `/rotation`.
- `GH_TOKEN` sanity check: `GET /repos/BlakeHan01/brawl-picks/actions/workflows/daily.yml` with the token → 200. (A `GET .../actions/permissions` returns 403 — expected, the token has no admin permission; it does not affect dispatch.)

## ✅ Verified — cron

**Verified 2026-11-20 ~22:35 PST.** The Worker's cron fired on schedule: a `daily.yml` run on branch `main` was created at **2026-11-21T06:17:23Z (22:17:23 PST Nov 20)** — exactly the first `17 */3 * * *` (UTC) fire after the ~03:54 UTC deploy — with event `workflow_dispatch`.

- Run: [44874827218](https://github.com/BlakeHan01/brawl-picks/actions/runs/44874827218) — **completed, success**
- Jobs: `data` ✓ 3m39s, `deploy` ✓ 8s
- (Note: the earlier draft of this doc said the first fire would be 05:17 UTC / 21:17 PST — that was a misread; 05:17 UTC is 21:17 PST on Nov 19, before the deploy. The correct first fire was 06:17 UTC / 22:17 PST Nov 20, which is what fired.)

## What Claude should do (site side)

1. Set `API_BASE` to the URL above.
2. Rotation: fetch live on load and every few minutes; merge with the static file for mode names, colours, map images. Fall back to `data/rotation.json` if the Worker fails.
3. Curated pick: user enters their tag once (stored on their device), site calls `/player/:tag`, ranks *their* brawlers per map, top 5 with what's missing. If lookup fails, show "player lookup unavailable".
4. Do not change `worker/`, the cron, or either secret. If an endpoint misbehaves, report the exact status/body — don't work around it by calling the Brawl Stars API or the RoyaleAPI proxy directly from the browser (the key must never be client-side).

## Things to ignore / not redo

- Do NOT re-register the Brawl Stars developer account or re-create the `brawl-picks` key. Do NOT re-create the `brawl-picks-worker` GitHub token.
- The Cloudflare dashboard shows a build (#979c8550, "Manually deployed", root `/`, deploy command `npx wrangler deploy`) that was started from the dashboard while the subdomain was being registered. It is NOT the deploy path — `wrangler deploy` from `worker/` is canonical, and the URL above is the live one. That dashboard build will likely fail (no `wrangler.toml` at repo root); ignore it, don't "fix" it by moving `wrangler.toml` to the root.
- The original handoff (`docs/HANDOFF-cloudflare-worker.md`) is now fully fulfilled. Its "Done when" checklist: rotation ✓, player 404/400 ✓, CORS header ✓ (browser-console check from the live site is still yours to do after you wire up `API_BASE`), cron ✓ (verified 2026-11-20 22:35 PST — run 44874827218 fired at 06:17:23Z and succeeded), no secrets in repo ✓, worker tests ✓ (13 passing).
