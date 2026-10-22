# agent-federation (BLIP)

BLIP is a personal AI agent built entirely on free, no-card tiers: a Cloudflare Worker brain,
one Durable Object per session with SQLite behind it, and a single-file web console served from
the same Worker. The model gets five tools, `exec`, `web_search`, `schedule_task`,
`save_workspace`, `delegate`, and runs inside one `ThinkHarness` loop from the `agents` SDK. Scheduled jobs
fire from a self-rearming alarm.

There is no build step and no framework. `ui/index.html` is plain DOM and one `EventSource`.

## How a turn moves

```
console  POST /api/sessions/:id/message   -> { streamId, operationId }        (returns at once)
         GET  /api/sessions/:id/stream/:streamId?token=  -> SSE frames        (durable, per operation)
brain    ThinkHarness turn -> chunk -> src/frames.ts -> StreamHub -> SSE
```

The frames union is the console's whole vocabulary: `text`, `reasoning`, `tool-start`,
`tool-progress`, `tool-result`, `approval`, `state`, `step`, `done`, `error`. It is defined in
`src/frames.ts` with its mapping tests in `tests/frames.test.mjs`; change it there, not in the UI.

## File map

| Path | What it owns |
|---|---|
| `src/index.ts` | The non-session HTTP surface: `/health`, `/api/tasks`, `/api/approve`, `/api/decide`, five `/internal/vault/*` handlers, and the WebSocket upgrade. Delegates `/api/sessions*` to `src/routes.ts` |
| `src/routes.ts` | The fifteen `/api/sessions*` shapes, four of them workspace ones. The only part of the worker's HTTP surface an offline test can drive |
| `src/agent.ts` | `FederationAgent`, the per-session DO: the harness turn path, directives, memory, scheduled jobs, approvals, workspace snapshotting, the alarm tick |
| `src/registry.ts` + `registry-store.ts` + `registry-input.ts` | `RegistryAgent`, the session index the sidebar reads |
| `src/harness.ts` + `harness-config.ts` | The one `ThinkHarness` instance and its options object (12 steps, recovery `{2, 1000, 120000}`, compact after 80 000 tokens) |
| `src/tools.ts` + `capabilities.ts` | The five tool definitions and the one table every capability claim renders from |
| `src/approval.ts` + `guardrails.ts` | The gate: only `exec` can be held, and only when the command text looks risky |
| `src/directives.ts` | `run:` / `exec:` / `execute:` / `search:`, the deterministic paths that bypass the model entirely |
| `src/frames.ts` + `stream-hub.ts` | The wire vocabulary and the durable per-operation buffer that survives a mid-turn eviction |
| `src/provider.ts` + `router.ts` | The AI SDK language model and the fetch that reaches the router binding |
| `src/reply.ts` | Harness `PromptResult` projected onto the console's `AgentReply` |
| `src/memory.ts` + `vault.ts` + `titles.ts` + `session-scope.ts` + `sql-handle.ts` | Support modules, all dependency-free enough to import from plain Node |
| `ui/index.html` | The console: mascot, sidebar, chat, live tool cards, approval card |
| `deploy/router-worker` | `zay-router`, the cloud model router the brain binds to |
| `deploy/sandbox-worker` | `zay-sandbox`, the E2B microVM runner |
| `deploy/northflank-9router`, `deploy/render-9router`, `pipedream/` | DEAD configs for abandoned hosts. Do not deploy from them |
| `tests/` | Offline suite plus three live scripts. Read `tests/README.md` for what each one proves |

## HTTP surface

Fifteen session shapes are listed at the top of `src/routes.ts`: the eight the family had through
Phase 3, Task 30's four workspace shapes (`GET .../workspace`, `GET .../workspace/files`,
`GET .../workspace/archive`, `DELETE .../workspace/files/<path>`), Task 33's `POST .../read`, and
the per-chat picker's `GET` and `PUT .../model`. The rest, from `src/index.ts`:

| Route | Auth | Returns |
|---|---|---|
| `GET /health` | none | `{ok:true}` |
| `GET /api/tasks` | `AGENT_API_KEY` | `{ok:true, tasks:[...]}` |
| `POST /api/approve` | `AGENT_API_KEY` | the resumed turn, projected as an `AgentReply` |
| `POST /api/decide` | `AGENT_API_KEY` | the cheap-lane mascot state decision |
| `POST /internal/vault/push`, `GET /internal/vault/chunk`, `/pull`, `/health`, `DELETE /internal/vault` | `STATE_KEY` | the chunked router-state blob |
| anything else | none | served from `ASSETS` (the console) |

Vault routes 401 until `STATE_KEY` exists; the check is `STATE_KEY.length > 0`, so an unset
secret fails closed.

## Env (names only, never values)

Plain vars: `ROUTER_URL`, `MODEL_PRIMARY`, `MODEL_CHEAP`. Secrets: `ROUTER_KEY`, `AGENT_API_KEY`,
`STATE_KEY`, `SBOX_TOKEN`. Bindings: `ASSETS`, `ROUTER` -> `zay-router`, `SANDBOX` ->
`zay-sandbox`, `FEDERATION_AGENT`, `REGISTRY`. Cron `*/10 * * * *` pings `RENDER_URL/health`.

`.dev.vars` is gitignored and holds your own values. The committed `.dev.vars.example` is a
placeholder file with no working credentials.

## Local dev

```sh
npm install       # agents 0.28.1, ai 7.0.143, @ai-sdk/openai-compatible 3.0.71, zod 4.6.7
cp .dev.vars.example .dev.vars   # then fill it in by hand
npm run dev        # wrangler dev on :8787
npm run typecheck  # tsc --noEmit, src only
npm test           # node tests/run-all.mjs, offline only, no network
```

Two gotchas that cost time:

1. Cross-worker `services` bindings do not resolve in a standalone `wrangler dev`, so locally the
   sandbox tools answer `sandbox not configured` and chat uses the public `ROUTER_URL`.
2. `tsconfig.json` has `include: ["src"]` and `deploy/**` has no tsconfig, so the two satellite
   workers are never typechecked by `npm run typecheck`.

## What is not here

Vector memory and the Telegram bridge are on hold. There is no sub-agent tool yet, no CI, and no
test framework: every test is a plain `.mjs` that exits 0 or 1.
