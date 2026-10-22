# BLIP exploration fleet: findings + roadmap

Nine read-only analysts, one per subsystem, explored the codebase (and the relevant
official docs) and wrote a report next to this file. None of them edited source.
This README is the index and the prioritized plan.

**Superseded on 2026-10-18, then largely executed.** The streaming, tools, prompts-memory,
e2b-sandbox and cron items below were re-examined against the installed `agents@0.28.1` type
definitions, and the conclusion changed: most of these gaps are SDK primitives BLIP never wired up,
not things to hand-build. That diagnosis became a spec
([`docs/superpowers/specs/2026-10-18-agent-loop-upgrade-design.md`](../superpowers/specs/2026-10-18-agent-loop-upgrade-design.md))
and then the plan that was actually built:
[`docs/superpowers/plans/2026-10-18-agent-loop-upgrade.md`](../superpowers/plans/2026-10-18-agent-loop-upgrade.md).
The plan file is the successor to this roadmap: read it for what shipped, task by task.

Status tags on the items below:
- **[shipped]** this plan built it; the named `tests/` file is the offline proof where one exists.
- **[partial]** the headline defect is fixed; the rest of the item is not in this plan.
- **[held]** the user put it on hold; the source exists but it is not shipped.

Verification key: **[V]** = I (the controller) independently confirmed the finding by
reading the actual code or the installed SDK. **[2+]** = two or more agents flagged it
independently. **[1]** = single-source, plausible, verify before acting.

## Reports

| File | Subsystem | Headline |
|---|---|---|
| [streaming.md](streaming.md) | Token streaming | Router already streams; the brain pins `stream:false` and buffers, and the quick tunnel buffers SSE. |
| [cron-scheduling.md](cron-scheduling.md) | Cron / jobs | `armTick` passes milliseconds where the SDK expects seconds; every self-scheduled wake is ~1000x late. |
| [security-guardrails.md](security-guardrails.md) | Auth / guardrails | Routes fail open on an empty key; a TEMP debug endpoint leaks the router URL. |
| [tools.md](tools.md) | Tool surface | Unknown tool names silently fall through to `exec "true"` and report success. |
| [e2b-sandbox.md](e2b-sandbox.md) | Sandbox | Workspace persistence is a base64 tar in KV; it breaks at ~1-2 MB and silently loses data. |
| [prompts-memory.md](prompts-memory.md) | Prompts / memory | Recall is a single 120-char substring LIKE that almost always misses; "cheap" tier is not cheaper. |
| [router-models.md](router-models.md) | LLM router | The 530 is transport (rotating quick tunnel); `aggregateSSE` drops `tool_calls`. |
| [web-search.md](web-search.md) | Web search | Paid provider advertised as free; over-fetches 10 results, shows 5; defaults to the priciest mode. |
| [ui-ux.md](ui-ux.md) | Console UI | Chat history is browser-RAM only; the API key sits in localStorage; Docs/Ideas are placeholders. |
| [live-test-report.md](live-test-report.md) | Live prod e2e test | Every tool exercised against the deployed worker. Confirms the P0 fixes are live; finds the real blockers: quick-tunnel timeouts, /api/decide dead (model not routable on zay-router), save_workspace broken (/workspace permission denied), streaming absent. |

## P0, do first: tiny fixes, big blast radius

1. **Scheduling unit bug [V][2+]** [src/agent.ts:406](). `this.schedule()` takes a number
   as SECONDS (confirmed in the SDK: `parseWhen`, `time = (nowMs + when*1000)/1000`), but
   `armTick` passes `delayMs` (the 60_000 default and the `soonest - Date.now()` delta are
   milliseconds). Effect: a task due in 30s wakes ~83 min late, and the idle poll lands
   ~16h out. Nothing is ever on time. One-line fix (divide by 1000, or pass a `Date`).
   **[shipped]** `armTick` now passes `new Date(wakeAt)` so the unit cannot be misread, and the alarm
   re-arms through a cancel-then-arm dedup. The one-off and daily task lifecycle is pinned offline by
   `tests/memory.test.mjs`; the wake time itself is only checked live.
2. **Fail-closed auth + delete the debug leak [V]** [src/index.ts:128-139, :61, :116](). The
   `/api/decide` `__debug_url` branch prints `ROUTER_URL` and key length and must go. HTTP
   routes use `===` on secrets and accept `Bearer undefined` when a key is unset. One shared
   constant-time, fail-closed auth helper.
   **[shipped]** one shared bearer check (`src/auth.ts`: `tokenOk`, `vaultAuthed`, and the sandbox's
   mirrored `authed`) fails closed on an unset or blank secret and compares through `safeEq`; the
   `__debug_url` branch is gone. Pinned offline by `tests/sse-auth.test.mjs` and the bearer gate in
   `tests/workspace.test.mjs`.
3. **Unknown tool silently execs `true` [V]** [src/agent.ts:848-849](). The dispatch `else`
   treats any unhandled tool name as `exec` with `args.cmd || "true"`, so a hallucinated tool
   returns a fake `exit 0 (success)`. Make the default branch return an error listing valid
   tools.
   **[shipped]** the hand-written dispatch that fell through to `exec "true"` is gone: tools are AI
   SDK `tool()` objects (Task 12), so a name that is not registered is never dispatched.
   `tests/tools.test.mjs` pins that the wired set is exactly `EXPECTED_TOOLS`.
4. **`run:` prefix matches ordinary sentences [V]** [src/agent.ts:80]().
   `DIRECT_RUN_RE = /^(run|exec|execute)\s*[:\s]\s*(.+)$/` accepts whitespace as the
   separator, so "run the tests" executes the shell command `the tests` with no model round
   trip and no risk gate. Require the colon (or a hard boundary).
   **[shipped]** the regex moved out of `src/agent.ts` into `src/directives.ts` as `parseDirective`
   (`RUN_RE` requires a colon, both arms reject an empty argument). Pinned offline by
   `tests/prefix.test.mjs`. The old `DIRECT_RUN_RE` identifier no longer exists.
5. **Telegram bridge has no owner allowlist [1]**
   [deploy/telegram-bridge/src/index.ts:23-59](). Any inbound chat can hit the `run:` path.
   Verify, then gate to the owner id.
   **[held]** the bridge is on hold and not shipped, so this gate was not added. `deploy/telegram-bridge`
   stays as source only; it is built and typechecked (its own `tsconfig.json` passes clean) but never
   deployed.

## P1: the headline features and the honest-data fixes

6. **Streaming (the user's #1 gap) [V]**. Design is in streaming.md. Path: emit `delta` /
   `tool_start` / `tool_end` / `done` frames over a single SSE endpoint (and/or the existing
   WS). The router can already stream; switch chat to the `ROUTER` service binding instead of
   a URL (also kills the 530), fix `aggregateSSE` to keep `delta.tool_calls` +
   `reasoning_content`, stop the self-critique pass from doubling time-to-first-token, and
   render per-token in the UI (today `renderThread` replaces whole `innerHTML`). Effort L,
   highest value.
   **[shipped]** Tasks 18-24: the frame protocol (`src/frames.ts`), one durable stream per turn
   (`src/stream-hub.ts`), a DO-served SSE route authenticated by query token (`src/auth.ts` `tokenOk`
   plus the proxy in `src/routes.ts`), and the console rendering frames as they arrive. Pinned offline
   by `tests/frames.test.mjs`, `tests/stream-hub.test.mjs` and the stream-proxy checks in
   `tests/routes.test.mjs`.
7. **Scheduling reliability (rest of cron.md)**. `schedule_task` INSERTs but never re-arms the
   single alarm [src/agent.ts:814](); no claim/lock so ticks can double-fire side effects
   [src/agent.ts:348-351](); timezone is UTC (`setUTCHours`) so "8am" is 09:00 Casablanca and
   Ramadan is not a fixed offset [src/memory.ts:180](); the `*/10` cron only pings Render and
   never touches the DO [src/index.ts:297](). Add: per-user IANA timezone, re-arm on enqueue,
   a run-history/status store, and surface results (today nothing writes `status='done'`, so
   the completed board is permanently empty [V]).
   **[partial]** this plan re-arms the single alarm on enqueue and surfaces a finished scheduled run
   back into main's transcript with a badge (Task 33), and the one-off prune plus `dueTasks` are pinned
   by `tests/memory.test.mjs`. The per-user IANA timezone, a durable run-history store, and moving the
   `*/10` cron onto the DO were not in this plan.
8. **Memory recall (prompts-memory.md) [V]**. `recall(sql, content.slice(0,120))` is one
   contiguous substring LIKE; it misses, then injects the global top-8 by importance, which is
   error logs and raw stdout dumps. Nothing ever writes a `user`/`preference` memory, so
   "I remember you" is false today. Concrete vector plan: Path B (embed on write, cosine over a
   DO SQLite Float32 BLOB, keep LIKE as fallback, effort S), then Path A (Workers AI `bge-m3` +
   Vectorize, effort M). Add a forgetting/compaction pass and stop injecting raw tool dumps.
   **[partial]** the LIKE recall was made honest and correct (case-insensitive, metacharacters escaped,
   ordered by importance then recency, raw tool dumps kept out of the prompt; Task 16), pinned offline by
   `tests/memory.test.mjs`. The embedding/vector path is **[held]**: `src/memory.ts` still carries the
   `swap for embedding similarity` TODO, and the user put vector memory on hold.
9. **Sandbox persistence (e2b-sandbox.md) [1]**. Move off the KV base64-tar (25 MB KV limit,
   ARG_MAX at ~1-2 MB, restore swallows every error) to E2B native pause/resume or R2 objects;
   bake a template so python and boot latency are fixed at once.
   **[shipped]** Tasks 26-30: one measured gzip tar per session in the existing `SESSIONS` KV namespace
   with the bytes moved through the sandbox file API (no base64 through a shell argument), a size gate
   that refuses over-limit turns without touching the good copy, the three restore states reported
   separately, and a per-session cap with an aligned lease (KV row TTL no longer than the VM lease).
   Pinned offline by `tests/workspace.test.mjs`, `tests/workspace-keys.test.mjs`,
   `tests/workspace-store.test.mjs` and `tests/sandbox-scope.test.mjs`. The R2-object variant stayed
   **[held]**: no bucket was provisioned, so `WORKSPACE_R2` is left optional and the code fails closed.
10. **Search + router honesty + cost**. web-search.md and router-models.md: stop advertising a
   paid provider as free; send `max_results` (pay for what you show), add `mode`/recency/
   filters, cache; make `MODEL_CHEAP` actually differ from `MODEL_PRIMARY` or drop the tier
   claim [V]; add upstream timeouts + backoff/jitter + faithful 429/401 surfacing.
   **[partial]** the router half shipped: every LLM call now reaches the `ROUTER` service binding at one
   endpoint with `X-Tier` deleted (Tasks 3, 11), pinned by `tests/provider.test.mjs` and
   `tests/router.test.mjs`. The web-search provider honesty, the `MODEL_CHEAP` tier claim, and upstream
   timeouts/backoff were not addressed by this plan.

## P2: hardening and polish

- New workflow tools (tools.md): `files` (read/write workspace without echo|base64),
  `read_url`, `jobs` (list/cancel), a model-facing `memory` tool, `reset_sandbox` (the
  `/session/kill` endpoint exists but is unreachable).
  **[partial]** a real workspace file read/delete route shipped (Task 30) and a child agent with a
  `delegate` tool shipped (Tasks 31, 32), pinned by `tests/routes.test.mjs` and `tests/child.test.mjs`.
  `read_url`, a jobs list/cancel tool, a model-facing `memory` tool and a wired `reset_sandbox` were
  not built.
- Guardrails v2: allow-list-first (the blocklist regex is bypassed by `python -c`,
  `base64|sh`, staged downloads, `curl` exfil).
  **[partial]** Task 34 closed the four named bypasses and `tests/guardrails.test.mjs` pins `isRisky`;
  the full allow-list-first rewrite (keeping the blocklist only as a deny layer) was not done.
- Prompt-injection fencing: wrap `web_search`/`exec` output as untrusted and never
  auto-exec from a tool-read trigger.
  [not in this plan] no task covered it.
- UI: real history endpoint, a Stop/cancel button, tier switch, notifications for finished
  jobs, and a genuine Docs store (the user wants agent-made docs saved here).
  **[partial]** session history and per-token frame rendering shipped (Tasks 7, 10, 24), the tier
  switch went away with `X-Tier` (Task 3), and an abort route is covered by `tests/routes.test.mjs`.
  A Stop/cancel button, finished-job notifications and a real Docs store were not built.
- Remove fake controls the agents found (fake 60% progress bar, fake tool toggles, facade
  chat list), align the sandbox lease (KV 600s vs E2B 300s), and add observability.
  **[partial]** the sandbox lease is aligned (Task 28, KV row TTL no longer than the VM lease, pinned by
  `tests/sandbox-scope.test.mjs`); removing the fake controls and the observability work are not verified
  from this roadmap.

## One theme to fix as a class

Capability copy is wrong in several places at once (system prompt, the hardcoded "what can you
do" reply, and README all disagree on free/remember/tools-count). Generate those claims from
the wired tools so they cannot drift. See prompts-memory.md and web-search.md.

**[shipped]** Task 29: the capability text is generated from `src/capabilities.ts` and served at
`GET /api/capabilities`, and `tests/no-drift.test.mjs` fails if a second hand-written copy (or an
unhedged future-tense promise, or an em dash) comes back in any shipped surface.
