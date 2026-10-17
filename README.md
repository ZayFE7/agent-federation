# agent-federation (BLIP)

BLIP is a personal AI agent built entirely on free, no-card tiers: a Cloudflare Worker brain
backed by one Durable Object with SQLite memory across sessions, driven from a single-file web
console. Chat fans out through a tiered model router (`primary` / `cheap`, `jev` reserved), the
edge twin of the user's old local 9router API-key layer. The model gets three tools, sandbox
`exec`, `schedule_task`, `save_workspace`, and jobs fire from a self-rearming 1 minute alarm.

Runtime: Worker `src/index.ts` + DO `FederationAgent` (binding `FEDERATION_AGENT`, sqlite
migration, `wrangler.jsonc:15-28`) + Assets from `./ui` as `ASSETS`, `run_worker_first: true`
(`:6-10`) + service bindings `ROUTER` -> `zay-router`, `SANDBOX` -> `zay-sandbox` (`:11-14`) +
cron `*/10 * * * *` (`:31-33`), whose handler only pings `RENDER_URL/health` (`src/index.ts:253-263`).

## File map

- `src/index.ts` (264 lines): the HTTP surface listed below.
- `src/agent.ts` (521): the DO. Persona `You are Blip` (`:34-35`), hard rule (`:56-57`), prompt
  builder (`:73-90`), router POST with `X-Tier` and 25 s abort (`:365-375`), tier to model
  (`:257-262`), tool loop capped at 4 rounds (`:362`), deterministic mascot state (`:496-518`).
- `src/memory.ts` (157) and `src/vault.ts` (104): the `memories` / `messages` / `tasks` tables
  (`memory.ts:46-79`) and the chunked blob vault (`MAX_CHUNK_BYTES = 1_400_000`, `vault.ts:8`).
- `src/types.ts` (71): tiers (`:3`), `AgentReply` (`:28-36`), `Env` (`:47-71`), defaults (`:44-45`).
- `ui/index.html` (371): console titled `Blip app v7`; mascot SVG and state table `S` (`:288-300`),
  tabs chat/tasks/docs/ideas/tools (`:321`). Plain `fetch`, no WebSocket, no markdown renderer,
  reply text injected raw, demo placeholder strings still present (`:322`, `:330`, `:338`).
- `pipedream/router.py` + README: abandoned predecessor router, superseded by `deploy/router-worker`.
- `tests/live-matrix.mjs`: the only test, see `tests/README.md`.

## HTTP surface, as read from `src/index.ts`

| Route | Line | Auth | Returns |
|---|---|---|---|
| WS upgrade passthrough | 33 | none | forwarded to the DO stub |
| `GET /health` | 38 | none | `{ok:true}` |
| `POST /api/message` | 42 | `AGENT_API_KEY` | full `AgentReply`: `reply`, `state`, `verb`, `tools[]` |
| `GET /api/tasks` | 62 | `AGENT_API_KEY` | `{ok:true, tasks:[...]}` |
| `POST /api/decide` | 71 | `AGENT_API_KEY` | LLM mascot decider, unused by the UI; `context:"__debug_url"` probe `:85-95` |
| `POST /internal/vault/push` | 156 | `STATE_KEY` | one base64 chunk, `{ok, idx, total}` |
| `GET /internal/vault/chunk` \| `pull` \| `health` | 179, 201, 221 | `STATE_KEY` | one chunk plus `x-vault-total` \| whole blob octet-stream \| metadata |
| `DELETE /internal/vault` | 233 | `STATE_KEY` | `{ok:true}` |
| anything else | 246 | none | served from `ASSETS` (the console) |

Vault auth also requires `STATE_KEY.length > 0` (`:152-154`), so all five vault routes 401
until that secret exists.

## Env (names only, never values)

`ROUTER_URL`, `MODEL_PRIMARY`, `MODEL_CHEAP` are plain vars (`wrangler.jsonc:37-41`);
`ROUTER_KEY` and `AGENT_API_KEY` are secrets documented at `:42-44`; `STATE_KEY`
(`src/types.ts:58`) and `SBOX_TOKEN` (`:68`) are secrets **no wrangler config mentions**;
`RENDER_URL` (`:60`) is optional and absent from `wrangler.jsonc`; bindings are `ASSETS`,
`ROUTER`, `SANDBOX`, `FEDERATION_AGENT`.

`.dev.vars` is byte-identical to `.dev.vars.example` and contains **no working credentials**:
`ROUTER_URL` and `ROUTER_KEY` empty, `AGENT_API_KEY=generate-me`, models still at the
`meta/muse-spark-1.3*` fallbacks, `STATE_KEY` and `SBOX_TOKEN` missing. Anyone who reads it
expecting live credentials will waste time.

## Deployables and local dev

Order: `deploy/router-worker`, then `deploy/sandbox-worker` (the brain binds to both by name,
`wrangler.jsonc:11-14`), then this brain, then `deploy/telegram-bridge` if wanted. Each satellite
carries its own `wrangler.jsonc`, KV ids and secrets.

```sh
npm install
cp .dev.vars.example .dev.vars   # pointless as-pulled: identical file, no secrets
npm run dev                      # wrangler dev on :8787
npm run typecheck                # tsc --noEmit, src only
```

## Structural gotchas

1. `wrangler.jsonc` sets no `compatibility_flags`, but the Agents SDK requires
   `["nodejs_compat"]` (`node_modules/agents/docs/configuration.md:56-62`), used at `src/agent.ts:1`.
2. Cross-worker `services` bindings do not resolve in a standalone `wrangler dev`, so sandbox
   tools answer `sandbox not configured` (`src/agent.ts:435,455`) and chat uses the public
   `ROUTER_URL`. Also `tsconfig.json:14` is `include: ["src"]` while `deploy/sandbox-worker` and
   `deploy/telegram-bridge` have no `tsconfig.json`, so `deploy/**` is never typechecked.

## Obsolete content in the previous version of this file

An older copy (still inside `BLIP-export.zip`, dated 2026-10-11) must not be trusted: it named
Pipedream as *the* router, claimed `POST /api/message` returns `{reply}` only, wrote "Sandbox
execution comes later", listed Pipedream env trios as the live contract, and never mentioned
`STATE_KEY`, `SBOX_TOKEN`, `RENDER_URL` or the `ROUTER`/`SANDBOX` bindings. This file supersedes it.

Not verifiable from this machine, and nothing here was run or deployed: deployed cloud state,
router KV contents, whether `wrangler dev` works with fresh secrets, provider key validity.
See `../../GAPS.md` and `../../RECOVERY.md`.
