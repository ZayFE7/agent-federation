# deploy/router-worker (zay-router)

Edge twin of the API-key layer of the user's local 9router: an OpenAI-compatible
front door that resolves a requested model name to a ranked list of upstream connections
and forwards with the right credential shape. It runs on Cloudflare Workers, not on the
laptop, so it stays reachable when the old PC is off.

- V1 (API-key providers, prefixes, combos, aliases, media path mapping, streaming
  passthrough, priority rotation) is written and was live on the old Cloudflare account
  at `https://zay-router.agent-federation.workers.dev`.
- V2 (OAuth lanes: `ag` / antigravity, websearch, qoder, kiro, cursor, xai) was **never
  started**. `src/index.ts:36-44` only declares the row type; there is no
  `src/antigravity.ts`, no refresh call, no overlay merge (`src/index.ts:31-34` says so).

## Routes (`src/index.ts`)

`OPTIONS` CORS preflight `:290`, `GET /health` `:300` (reports connection and combo counts
plus prefixes, never credentials), `POST /debug-oc` `:314` (one-off OpenCode free-tier
probe), then under a bearer check against `cfg.authKeys` (`:350-363`): `GET /v1/models`
`:373`, `POST /v1/chat/completions`, `/v1/responses`, `/v1/messages` and media paths
(`:404-445`). Unroutable model gives a 404 that lists available combos and prefixes
(`:409-420`); all candidates failing gives 502 (`:500`).

## Configuration

`loadConfig()` reads KV binding `ROUTER_CONFIG`, key `router:config`, as JSON, with a
60 s isolate cache (`src/index.ts:65-71`). If the key is absent every request throws
`router config missing in KV` (`src/index.ts:68`).

Config shape: `authKeys`, `providers`, `connections`, `combos`, `aliases`,
`aliasProviders`, optional `antigravity` (`src/index.ts:46-55`).

`router-config.json` is gitignored (`.gitignore` last line) and **does not exist here**.
It only ever lived on the old PC because it embeds provider API keys.

## extract-config.py (old-PC only, cannot run here)

`extract-config.py` built the KV payload from two old-PC sources: the read-only 9router
SQLite at `E:/Users/Zay%20L/AppData/Roaming/9router/db/data.sqlite` (`:18`) and the
9router Next.js provider catalog chunk `C:\npm-global\...\chunks\458.js` (`:19`), writing
`router-config.json` next to itself (`:20`). Seeding required an explicit remote push:
`wrangler kv put --remote` (local KV is the default trap). Print summary is counts only
(`:214-218`), never token values.

Counts it claimed on the last real extract, per `../../../memory/personal-agent-project.md`
line 13: 40 api-key connections with prefixes `smn LR JDW kk hc AR tr ai OR ab sr buds`.
`refresh-notes.md` section 4 counts 11 active antigravity OAuth rows, section 3 notes 2 of
those 11 were already past `expiresAt`, and section 5 adds that 4 of 11 had no `projectId`.
`_superseded/HANDOFF.md` recorded the deployed worker answering 41 connections and
4 combos on 2026-10-16; the one extra connection is the synthetic OpenCode free lane
injected at `extract-config.py:167-188`.

## refresh-notes.md

The OAuth contract for a future V2: Google token endpoint, embedded client id, exact
`URLSearchParams` refresh body, 5 minute refresh lead (`refreshLeadMs 3e5`), lazy
single-flight refresh, write-back rules, `invalid_grant` treated as permanent, never log
tokens, and the planned second KV key `router:ag-tokens` as a refresh overlay. Design only;
unimplemented.

## Blockers

- `wrangler.jsonc:9` carries KV id `45aef8b69a2b4b42997bd7dc24d435ea`. That is an **old
  account resource**; same-account reuse was reported verified in `_superseded/HANDOFF.md`,
  but a fresh namespace is the safe path (`../../../../SECRETS.md`, `../../../../RECOVERY.md`).
- No `package.json` here; it typechecks against the root `node_modules` and has its own
  `tsconfig.json` (the only satellite that does).
- Nothing can be seeded without 9router returning on this PC or a hand-built
  `router:config`. Until then `/health` returns 500 and all `/v1/*` returns 401.
- OpenCode free lane is a known dead end (DRM-locked to the desktop app); see
  `_superseded/HANDOFF.md` section 5.

Full gap detail lives in `../../../../GAPS.md`.
