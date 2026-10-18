# BLIP exploration fleet: findings + roadmap

Nine read-only analysts, one per subsystem, explored the codebase (and the relevant
official docs) and wrote a report next to this file. None of them edited source.
This README is the index and the prioritized plan.

**Superseded in part on 2026-10-18.** The streaming, tools, prompts-memory, e2b-sandbox and
cron items below were re-examined against the installed `agents@0.28.1` type definitions, and
the conclusion changed: most of these gaps are SDK primitives BLIP never wired up, not things
to hand-build. The current plan is
[`docs/superpowers/specs/2026-10-18-agent-loop-upgrade-design.md`](../superpowers/specs/2026-10-18-agent-loop-upgrade-design.md).
Read that first; treat the P0/P1 lists below as still-accurate diagnosis but not as the build
order.

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
2. **Fail-closed auth + delete the debug leak [V]** [src/index.ts:128-139, :61, :116](). The
   `/api/decide` `__debug_url` branch prints `ROUTER_URL` and key length and must go. HTTP
   routes use `===` on secrets and accept `Bearer undefined` when a key is unset. One shared
   constant-time, fail-closed auth helper.
3. **Unknown tool silently execs `true` [V]** [src/agent.ts:848-849](). The dispatch `else`
   treats any unhandled tool name as `exec` with `args.cmd || "true"`, so a hallucinated tool
   returns a fake `exit 0 (success)`. Make the default branch return an error listing valid
   tools.
4. **`run:` prefix matches ordinary sentences [V]** [src/agent.ts:80]().
   `DIRECT_RUN_RE = /^(run|exec|execute)\s*[:\s]\s*(.+)$/` accepts whitespace as the
   separator, so "run the tests" executes the shell command `the tests` with no model round
   trip and no risk gate. Require the colon (or a hard boundary).
5. **Telegram bridge has no owner allowlist [1]**
   [deploy/telegram-bridge/src/index.ts:23-59](). Any inbound chat can hit the `run:` path.
   Verify, then gate to the owner id.

## P1: the headline features and the honest-data fixes

6. **Streaming (the user's #1 gap) [V]**. Design is in streaming.md. Path: emit `delta` /
   `tool_start` / `tool_end` / `done` frames over a single SSE endpoint (and/or the existing
   WS). The router can already stream; switch chat to the `ROUTER` service binding instead of
   a URL (also kills the 530), fix `aggregateSSE` to keep `delta.tool_calls` +
   `reasoning_content`, stop the self-critique pass from doubling time-to-first-token, and
   render per-token in the UI (today `renderThread` replaces whole `innerHTML`). Effort L,
   highest value.
7. **Scheduling reliability (rest of cron.md)**. `schedule_task` INSERTs but never re-arms the
   single alarm [src/agent.ts:814](); no claim/lock so ticks can double-fire side effects
   [src/agent.ts:348-351](); timezone is UTC (`setUTCHours`) so "8am" is 09:00 Casablanca and
   Ramadan is not a fixed offset [src/memory.ts:180](); the `*/10` cron only pings Render and
   never touches the DO [src/index.ts:297](). Add: per-user IANA timezone, re-arm on enqueue,
   a run-history/status store, and surface results (today nothing writes `status='done'`, so
   the completed board is permanently empty [V]).
8. **Memory recall (prompts-memory.md) [V]**. `recall(sql, content.slice(0,120))` is one
   contiguous substring LIKE; it misses, then injects the global top-8 by importance, which is
   error logs and raw stdout dumps. Nothing ever writes a `user`/`preference` memory, so
   "I remember you" is false today. Concrete vector plan: Path B (embed on write, cosine over a
   DO SQLite Float32 BLOB, keep LIKE as fallback, effort S), then Path A (Workers AI `bge-m3` +
   Vectorize, effort M). Add a forgetting/compaction pass and stop injecting raw tool dumps.
9. **Sandbox persistence (e2b-sandbox.md) [1]**. Move off the KV base64-tar (25 MB KV limit,
   ARG_MAX at ~1-2 MB, restore swallows every error) to E2B native pause/resume or R2 objects;
   bake a template so python and boot latency are fixed at once.
10. **Search + router honesty + cost**. web-search.md and router-models.md: stop advertising a
   paid provider as free; send `max_results` (pay for what you show), add `mode`/recency/
   filters, cache; make `MODEL_CHEAP` actually differ from `MODEL_PRIMARY` or drop the tier
   claim [V]; add upstream timeouts + backoff/jitter + faithful 429/401 surfacing.

## P2: hardening and polish

- New workflow tools (tools.md): `files` (read/write workspace without echo|base64),
  `read_url`, `jobs` (list/cancel), a model-facing `memory` tool, `reset_sandbox` (the
  `/session/kill` endpoint exists but is unreachable).
- Guardrails v2: allow-list-first (the blocklist regex is bypassed by `python -c`,
  `base64|sh`, staged downloads, `curl` exfil).
- Prompt-injection fencing: wrap `web_search`/`exec` output as untrusted and never
  auto-exec from a tool-read trigger.
- UI: real history endpoint, a Stop/cancel button, tier switch, notifications for finished
  jobs, and a genuine Docs store (the user wants agent-made docs saved here).
- Remove fake controls the agents found (fake 60% progress bar, fake tool toggles, facade
  chat list), align the sandbox lease (KV 600s vs E2B 300s), and add observability.

## One theme to fix as a class

Capability copy is wrong in several places at once (system prompt, the hardcoded "what can you
do" reply, and README all disagree on free/remember/tools-count). Generate those claims from
the wired tools so they cannot drift. See prompts-memory.md and web-search.md.
