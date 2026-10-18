# BLIP: from chatbot to agent

Written 2026-10-18 after a full code read of the deployed worker and the installed
`agents` SDK (v0.28.1), plus a head-to-head against Meta Muse and Grok Bot.

The current design is kept. No UI redesign. This is an engine upgrade.

---

## 1. Verdict on "no agent loop"

You are mostly right, and the part you are wrong about is the interesting part.

There **is** a loop: `agent.ts:722`

```ts
for (let round = 0; round < 4; round++) {
```

It calls the model, runs whatever tools it asked for, pushes results back, repeats.
That is a real tool loop. But it is capped at **4 rounds**, it is **not durable**, it
is **not streamed**, and it **is not goal-driven**. Here is what that costs, all of it
verified in the code:

| # | Fact | Where | Effect |
|---|---|---|---|
| 1 | Hard cap of 4 model rounds | `agent.ts:722` | A real build needs 20-80 tool calls. BLIP gets ~4-12. |
| 2 | Hitting the cap returns a dead end | `agent.ts:913` | `"(hit the tool round limit; try a simpler ask)"`. Work is abandoned, not resumed. |
| 3 | Nothing drives the plan | `agent.ts:778-807` | `plan` writes a checklist to SQLite, `plan_done` ticks boxes. No controller resumes unfinished steps. The plan is decoration. |
| 4 | One router timeout discards everything | `agent.ts:736-747` | The `return` throws away `toolRuns` accumulated so far. You get "Router timed out" and lose the work. |
| 5 | Self-critique is a 5th blocking call | `agent.ts:918-921` | Every turn that ran a tool pays a second 20s round trip before you see anything. |
| 6 | No streaming anywhere | `agent.ts:725-753`, `ui/index.html:384` | `await response.json()` then `await r.json()`. One opaque blob after 10-60s. This is the #1 reason it feels like a chatbot. |
| 7 | Progress is reported after the fact | `agent.ts:716`, `:882` | `toolRuns` is returned in the final body. The UI cannot show "searching" while it searches, because by the time the UI knows, it is over. |
| 8 | One global Durable Object | `index.ts:23` `idFromName("main")` | Every conversation shares one DO and one flat `messages` table. There is no session to persist. |
| 9 | History is 6 messages | `agent.ts:532`, `memory.ts:144` | `recentMessages(sql, 6)`. The agent forgets mid-task. No compaction, just truncation. |
| 10 | One global sandbox | `agent.ts:486`, `:840` | `sessionId: "agent"` hardcoded. Every session shares one E2B machine and one filesystem. |
| 11 | Chat goes over a rotating quick tunnel | `agent.ts:725` `env.ROUTER_URL` | Buffering proxy in front of the stream, ~1 in 6 timeouts, and a hostname that changes on restart. The `env.ROUTER` service binding already exists and is unused for chat. |
| 12 | `X-Tier` is a dead header | `agent.ts:730` vs router grep | `deploy/router-worker/src/index.ts` never reads it. Sent for nothing. |
| 13 | `/workspace` does not exist | `agent.ts:607,614,667`, sandbox-worker `:55,109` | E2B base runs as non-root with home `/home/user`. `save_workspace` fails with exit 1, confirmed live. The prompt tells the model to save work that can never be saved. |

So: not "no loop". A loop that is too short, too fragile, invisible while it runs, and
shared by everyone at once.

---

## 2. Head to head

Sources: [Meta Muse announcement](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/),
[ai.meta.com/muse](https://ai.meta.com/muse/),
[Muse permissions and tools](https://www.fullstack.com/blog/inside-metas-muse-permissions-tools-and-personal-ai),
[Grok Bot guide](https://mem0.ai/library/llms-and-models/grok-bot-guide),
[x.ai news](https://x.ai/news).

| Capability | Meta Muse | Grok Bot | BLIP today | Gap |
|---|---|---|---|---|
| Own computer | Secure VM + own browser | Persistent cloud computer, browser + terminal | E2B microVM, shell + python3, no browser | **Half** |
| Computer survives restart | Yes | Yes | No. `/workspace` broken, one global session | **Broken** |
| Multi-step agent loop | Autonomous, long-running | Autonomous, long-running | 4 rounds, then quits | **Critical** |
| Survives a crash mid-task | Yes | Yes | No. One timeout discards the turn | **Critical** |
| Streams while working | Yes | Yes | No. Buffered JSON blob | **Critical** |
| Shows tool progress live | Yes | Yes | No. Tools reported after completion | **Critical** |
| Conversations / sessions | Yes | Yes, group chats | No. One global DO, 6-message history | **Critical** |
| Memory of preferences | Yes | Yes | LIKE substring match, misses constantly | **Weak** |
| Approval gate on risky acts | Yes, Sentinel reviews before internet access | Yes, explicit approvals | Yes, `isRisky` blocklist + hold/approve | **OK** (blocklist is bypassable) |
| Audit trail / activity review | Yes | Yes | Partial: `memories` table, no UI | **Half** |
| Scheduled / proactive work | Proactive suggestions, background monitors, goal tracking | Scheduled routines | `schedule_task` + DO alarms, fires correctly now | **OK**, but nothing surfaces results |
| Reusable skills | n/a | Yes | No | **Missing** |
| Multi-agent / sub-agents | n/a | Group chats, file sharing across bots | No | **Missing** |
| Plugins / MCP | App integrations | Plugins + MCPs | No | **Missing** |
| Browser automation | Yes, own browser | Yes | No (search only) | **Missing** |
| Payments | Stripe Link | n/a | No | Out of scope |
| Teaching by demonstration | n/a | Screen recording | No | Out of scope |
| Channels (Telegram, email, Slack) | Meta apps | X | Bridge exists, unwired, no allowlist | **Held by you** |

Honest read: BLIP has the **hardest** part already (a real Linux computer, a working
approval gate, working cron). It is missing the **cheap** parts that the SDK hands you:
the loop, the stream, the sessions, the durability.

---

## 3. Root cause

BLIP hand-rolled an agent on top of the `Agent` base class and used roughly 3% of the
SDK it installed. `agents@0.28.1` already ships every critical gap in that table:

| Need | SDK primitive | Verified |
|---|---|---|
| A real agent loop | `ThinkHarness` (`agents/harness/think`): `maxSteps` default **10**, server tools run one durable call at a time, per-tool `recovery: "rerun"` | `harness/think/index.d.ts:500` |
| Survives eviction mid-task | Its own doc comment: *"Durability is the Lifecycle's job queue... one wake job per session. While a session has work, the wake job reschedules itself as a heartbeat, so an eviction leaves it due and its alarm restarts the object. Each step of a turn reads only durable state, so the restarted object continues where the last write left off."* | `harness/think/index.d.ts:~485` |
| Sessions + transcripts | `Sessions` capability. `session(id)` handle: byte-budgeted reads, branch navigation, `search(sessionId, query, limit)`, media offload | `sessions/index.d.ts`, `handle-zAzh0UW2.d.ts:217` |
| Context compaction | `createCompactFunction().compactAfter(100_000)`, hermes-style iterative summaries | `handle-zAzh0UW2.d.ts:43-63` |
| Token streaming | `Streams` capability + `sseResponse(streams, streamId, {request})`: replays from `Last-Event-ID`, tails live, 30s `: heartbeat` comments to defeat buffering proxies, ends with `done`/`error` | `streams/index.d.ts`, `streams-vrCtbUIn.d.ts:297` |
| Per-tool live progress | `AgentToolProgressEmitter.report({fraction, message, phase, data})`, coalesced latest-wins, always flushes at `fraction >= 1`, persisted as a snapshot | `agent-tools-ohoewW-B.d.ts:54` |
| Human-in-the-loop | `toolApproval: ({session, toolName, toolCallId, input}) => boolean`, plus per-tool `needsApproval` | `harness/think/index.d.ts:~440` |
| Long background work | `runFiber` / `startFiber` / `cancelFiber` / `listFibers` / `onFiberRecovered`, `keepAliveWhile`, checkpoint via `ctx.stash()` | `agent-routing-BMvWTFEp.d.ts:5326-5360` |
| Durable replayable tasks | `this.tasks.run(name, input, options)` with `taskDefinitions`, `TaskStep`, retries, `NonRetryableError` | `tasks/index.d.ts` |
| Sub-agents | `this.dynamicAgents.get(Class, id)`: facet child agents, own isolate, own SQLite, supervised by the parent | `agent-routing-BMvWTFEp.d.ts:4648` |
| MCP client + server | `this.mcp` (`MCPClientManager`), `AddMcpServerOptions`, `agents/mcp/server` | `agent-routing-BMvWTFEp.d.ts:4711` |
| Reusable skills | `SkillRegistry`, markdown + frontmatter + scripts, R2-backed, `ComputerSkillWorkspace`, `runner` | `skills/index.d.ts` |
| Real browser | `agents/browser` + `agents/browser/ai-sdk` | `browser/index.d.ts` |
| Web search / fetch tools | `agents/websearch`, `agents/webfetch` | package exports |
| A real container computer | `agents/harness/container`: `claudeCode()`, `codex()`, `containerAgent()` | `harness/container/index.d.ts:153-205` |
| Channels | `agents/experimental/channels/{telegram,slack,email,web}`: `telegram(opts)`, `telegramWebhook(opts)` | `experimental/channels/telegram/index.d.ts:97-101` |
| Client-side tools | `agents/experimental/webmcp`, tools without `execute` run on the client | `harness/ai-sdk/index.d.ts` |

Two good pieces of news from the router read:

- **The router already streams.** `deploy/router-worker/src/index.ts:~480` only collapses
  SSE when `conn.forceStream && !clientWantedStream`. When the client sends `stream: true`
  it returns `new Response(res.body, ...)` untouched. `aggregateSSE` dropping `tool_calls`
  and `reasoning_content` (`:201-247`) therefore never fires on the streaming path.
- **`X-Tier` is dead.** The router never reads it. Delete it.

The one real blocker: chat uses `env.ROUTER_URL`, a rotating cloudflared **quick tunnel**
to a Render box. It buffers SSE and times out ~1 in 6. `env.ROUTER` (service binding to
`zay-router`, same account) already exists in `wrangler.jsonc` and is only used by
`/api/decide`. Service bindings do not buffer. **Switch chat to the binding and streaming
becomes possible.**

---

## 4. The plan

Six phases. Each ships alone and leaves the product working. Effort: S < M < L < XL.

### Phase 0: Unblock (S, do first, no new dependencies)

Nothing downstream works until these four are fixed.

1. **Chat onto the service binding.** `agent.ts:725` and `:995`: replace
   `fetch(this.env.ROUTER_URL, init)` with
   `this.env.ROUTER.fetch(new Request(this.env.ROUTER_URL, init))`.
   Kills the tunnel, the buffering, and the 530s. Falls back to plain `fetch` when the
   binding is absent, exactly like `index.ts:155-176` already does.
2. **Pin a routable model.** `MODEL_PRIMARY` and `MODEL_CHEAP` are both
   `cf/@cf/qwen/qwen3.8-27b`, which `zay-router` rejects with *"not routable in cloud
   twin (v1)"*. That is why `/api/decide` is dead in production. Pick one the router can
   actually serve, and make `MODEL_CHEAP` genuinely cheaper or drop the tier claim.
3. **Fix the workspace path.** `/workspace` does not exist and cannot be created by a
   non-root user. Change to `/home/user` in the prompt text (`agent.ts:592, 607, 614, 667`)
   and in the sandbox worker (`deploy/sandbox-worker/src/index.ts:55, 109`). Standardize
   on non-root `/home/user` everywhere.
4. **Delete the dead header.** Remove `"X-Tier"` from `agent.ts:730` and `:1000`.

Acceptance: `/api/decide` returns 200 with a classification; `run: ls -la /home/user`
lists files; `save_workspace` returns ok; a chat turn stops timing out ~1 in 6.

### Phase 1: Sessions (M)

The single global DO is why nothing persists. Fix the addressing first, before the loop.

1. **One DO per session.** `index.ts:23`: `idFromName("main")` becomes
   `idFromName("s:" + sessionId)`. Keep a `mainAgentId` for the scheduler-only DO.
   New routes: `POST /api/sessions` (create), `GET /api/sessions` (list),
   `GET /api/sessions/:id/messages` (history), `DELETE /api/sessions/:id`,
   `PATCH /api/sessions/:id` (rename).
2. **Session index in KV or a registry DO.** A per-session DO cannot enumerate itself,
   so keep `{id, title, created_at, updated_at, workspace_ref}` in one small registry
   (a second DO with SQLite, or KV). The registry is the sidebar's data source.
3. **Persist transcripts.** Replace `logMessage` / `recentMessages(sql, 6)` with the
   `Sessions` capability: `this.lifecycle.use(new Sessions())`, then
   `this.sessions.session(id).append(...)` and a byte-budgeted read instead of a
   6-row truncation. Add compaction: `createCompactFunction().compactAfter(100_000)`.
4. **AI-generated titles.** After the first assistant reply of a new session, fire a
   cheap-model call with the user's first message and a 3-5 word instruction, write it to
   the registry. Non-blocking: `void this.runFiber("title", ...)`. Never delay the reply.
   Fall back to a truncation of the first message if the call fails.
5. **UI.** Sidebar session list from `/api/sessions`, new-session button, rename, delete.
   Drop `localStorage` chat history and the two 401s the UI currently fires on load
   (`/api/tasks` and `/api/plan` before any key exists). Gate them behind having a key.

Acceptance: close the tab, reopen, the session list is there, click one, the full
transcript reloads, continue the conversation and it remembers. Two sessions running
side by side do not see each other's files or history. Titles are model-written.

### Phase 2: The agent loop (L, the heart of it)

Replace `handleChat` with `ThinkHarness`.

Why Think and not `AiSdkHarness`: the AI SDK harness's own doc comment says *"a run that
an eviction cuts short starts again from the saved transcript, and its unsaved output is
lost."* Think keeps in-flight output in a `Streams` capability and applies a per-tool
recovery policy, so a 40-minute build survives a DO eviction. That is the difference
between a demo and an agent.

1. **Install the harness.** In `FederationAgent.onStart()`:
   `this.lifecycle.use(new ThinkHarness({ model, tools, system, maxSteps, toolApproval, configureSession, hooks }))`.
2. **Model adapter.** `model` must be an AI SDK `LanguageModel`. Add `ai@^7` and an
   OpenAI-compatible provider pointed at the router, with a custom `fetch` that routes
   through the `env.ROUTER` service binding. `sessionAffinity` is available on `Agent` if
   you later move to Workers AI.
3. **Tools.** Port the existing six to AI SDK `tool({ description, inputSchema: z.object({...}), execute })`.
   Keep `exec`, `web_search`, `schedule_task`, `save_workspace`. Keep the exact
   descriptions already hardened by the tool-design pass. Mark `exec` with a
   `recovery: "rerun"` only where rerunning is safe; never for side-effecting commands.
4. **`maxSteps`.** Default 10 is still low for "build me an app". Set it per session via
   `PerSession<number>`: 10 for chat, 40-60 for a build. Make it a request field so the UI
   can offer a "deep work" toggle.
5. **Approval.** Move `isRisky` from the dispatch `else` branch into
   `toolApproval: ({toolName, input}) => toolName === "exec" && isRisky(input.cmd)`.
   Same guardrails file, now enforced by the harness, which blocks durably and resumes on
   the answer instead of ending the turn. `approveAction` becomes an answer to a pending
   tool call, not a separate exec path.
6. **Plan becomes real.** Delete the `plan` / `plan_done` tools. Think's transcript,
   stream, and step events already give the UI a live checklist. If you want an explicit
   todo list, make it a `TaskCreate`-shaped tool the model maintains, driven by the loop
   rather than stored beside it.
7. **Drop self-critique from the hot path.** `agent.ts:918-921` currently adds a blocking
   20s call to every tool turn. Either delete it or move it to a detached fiber that can
   append a correction, never one that gates the reply.
8. **Kill the deterministic bypasses' special-casing.** `run:` and `search:` stay (they
   are genuinely useful and 100% testable) but must emit the same tool-run events as the
   model path, so the UI renders a card for them. Today `run:` returns no `tools` array
   at all (`agent.ts:554`), which is why `live-matrix.mjs` case 2 fails.

Acceptance: "build me a habit tracker as a single page app, write the files, run it,
and show me the output" completes in one turn with 15+ tool calls, no round-limit
message. Kill the worker mid-build; the heartbeat alarm restarts the DO and the turn
continues from durable state. `rm -rf` still holds for approval and resumes after it.

### Phase 3: Streaming and live tool widgets (L, the visible payoff)

1. **Open a durable stream per turn.** On submit, `this.streams.open(streamId, {tag})`,
   then in `hooks.onChunk` append every UI chunk. Think writes in-flight output to a
   `Streams` capability already; the work is exposing it.
2. **Serve it as SSE.** New route `GET /api/sessions/:id/stream/:streamId` returning
   `sseResponse(this.streams, streamId, { request })`. That gives `Last-Event-ID` resume
   for free, a 30s heartbeat that defeats buffering proxies, and `done`/`error`
   termination. The client is `new EventSource(url)`; reconnect resume is automatic.
3. **Per-tool progress.** Inside each tool's `execute`, call
   `reportProgress({ phase, fraction, message, data })`. Concrete vocabulary, mapped to
   the widgets you already have:
   - `web_search`: `phase: "searching"`, `message` = the query, an indeterminate bar;
     on result, `fraction: 1` with `data: {count}`.
   - `exec`: `phase: "running"`, `message` = the command; stream stdout lines into
     `data.tail` as they arrive so the card fills in live.
   - `save_workspace`: `phase: "snapshotting"` then `fraction: 1` with byte count.
   - `schedule_task`: `phase: "scheduling"`, `data: {when}`.
   - sub-agent / container tools: forward child progress via `interceptAgentToolBroadcast`.
   The emitter coalesces bursts latest-wins and always flushes the `fraction >= 1` frame,
   so a fast tool cannot lose its terminal state.
4. **UI rendering.** `ui/index.html:384` `fedChat` stops doing `await r.json()`. Replace
   with an `EventSource`, and replace `renderThread`'s whole-`innerHTML` swap with
   incremental DOM: one live tool widget per `tool-input-start`, updated on
   `tool-progress`, collapsed on `tool-result`, text appended token by token. Keep every
   existing widget class (`.run`, `.card`, `.ch`, `.pv`, `.acts`, `.pill`, `.win`) as the
   visual vocabulary; they just get mounted and updated live instead of rendered once at
   the end. Inline in the message flow, per your Option A choice.
5. **Stop button.** `abort(session, operationId)` exists. Wire a cancel button to it.

Acceptance: type a message, see tokens appear, see a search bar pop up while it searches,
see shell output scroll into the exec card live, see the card collapse on completion.
Refresh mid-turn and the stream resumes from where it was.

### Phase 4: Workspace persistence (M)

You chose: files saved to a real store, restored into a fresh sandbox, rebuild delay
accepted. That is the right call; E2B pause/resume is not available on this setup.

1. **Per-session sandbox.** `agent.ts:486` hardcodes `sessionId: "agent"`. Pass the
   session id so each conversation gets its own E2B machine and its own filesystem.
2. **Real store, not a KV base64 tar.** The current snapshot is
   `tar czf - . | base64 -w0` into KV (`sandbox-worker:109`), which dies at the 25 MB KV
   value limit and at `ARG_MAX` around 1-2 MB, and swallows every restore error. Move to
   **R2**: upload the tarball as one object at `workspaces/{sessionId}/latest.tar.gz`,
   plus a manifest listing paths, sizes, and mtimes. R2 has no such limit and gives ranged
   reads.
3. **Automatic snapshots, not model-discretionary.** `save_workspace` today depends on the
   model remembering to call it. Snapshot on turn end and on a timer inside the fiber, so
   a crash loses at most the current turn.
4. **Restore on sandbox boot.** Sandbox worker boots a fresh E2B machine, pulls the
   object from R2, extracts into `/home/user`. Report the restore honestly: bytes, file
   count, duration. This is the "taking time to rebuild" you accepted; show it as a
   progress widget rather than a silent hang.
5. **User-facing file management.** `GET /api/sessions/:id/files` (list from the
   manifest), `GET .../files/:path` (download), `DELETE` for manual removal, since you
   asked for "until I manually delete it". Keep the existing `.docs` grid widget for it.
6. **Fix the prompt lie.** Whatever survives of the `save_workspace` description must stop
   promising that `/workspace` is snapshotted. Generate capability copy from the wired
   tool list so the system prompt, the "what can you do" reply, and the README cannot
   drift apart again. Today all three disagree.

Acceptance: build an app in session A, wait past the E2B lease (300s), come back to
session A, `run: ls -la /home/user` shows the files. Session B does not see them. Delete
a file from the UI and it stays deleted.

### Phase 5: Capability parity (XL, pick and choose)

Everything here is SDK-native and each item is independently shippable. Ordered by
value per unit of effort:

1. **Notifications (S).** Scheduled tasks already run and write `task-done` memories, but
   nothing reaches you. Push results to the session's `Streams` and surface a badge in the
   sidebar. This closes the loop you tested by hand last session.
2. **Browser tool (M).** `agents/browser` on Cloudflare Browser Rendering. Fills the
   biggest Muse/Grok gap: today BLIP can search the web but not read a page. Also add
   `agents/webfetch` as a cheap non-JS fallback.
3. **Skills (M).** `SkillRegistry` over R2: markdown + frontmatter + scripts the agent can
   load on demand. This is Grok Bot's headline differentiator and it is mostly plumbing.
   Your own `docs/explorations/` reports are already skill-shaped.
4. **Sub-agents (M).** `this.dynamicAgents.get(Researcher, id)` for parallel work, with
   child progress forwarded into the parent stream via `interceptAgentToolBroadcast`.
5. **MCP (M).** `this.mcp` for client, `agents/mcp/server` to expose BLIP itself as an
   MCP server. Instant access to the whole third-party tool ecosystem both competitors
   advertise.
6. **Real container (L, optional).** `agents/harness/container` with `containerAgent()`
   would replace E2B with a Cloudflare Container: no external lease, no snapshot dance,
   no tunnel. Bigger lift and a different billing shape. Revisit after Phase 4 proves out.
7. **Channels (S, held).** `agents/experimental/channels/telegram` replaces the unwired
   hand-rolled bridge. Still gated on your "mark", and it needs an owner allowlist first.
8. **Guardrails v2 (M).** `isRisky` is a blocklist and is bypassed by `python -c`,
   `base64 | sh`, staged downloads, and `curl` exfil. Both competitors gate at the
   permission layer, not the string layer. Move to allow-list-first plus a Sentinel-style
   review step on outbound network access.

### Phase 6: Honesty and hardening (S, continuous)

1. Vault endpoints (`index.ts:202-204`) still use `===` on `STATE_KEY`. Use `safeEq` and
   fail closed, same as `authed()`.
2. `MODEL_CHEAP === MODEL_PRIMARY`. Make it differ or stop claiming a cheap tier.
3. Generate every capability claim from the wired tool list.
4. Add observability: the SDK has `agents/observability` and `Agent.observability`. Turn it on.
5. Tests. Every phase above gets a deterministic test in `tests/` and a live case in
   `tests/live-matrix.mjs`. Fix the existing case 2 failure (it asserts `tools[0].cmd` on
   the `run:` path, which returns no tools array) as part of Phase 2.

---

## 5. Order and dependencies

```
Phase 0 (unblock)
   |
   +--> Phase 1 (sessions)  --+
   |                          |
   +--> Phase 2 (loop) -------+--> Phase 3 (streaming + widgets)
                                 |
                                 +--> Phase 4 (workspace persistence)
                                        |
                                        +--> Phase 5 (parity, pick items)
Phase 6 runs alongside everything
```

Phase 0 is a prerequisite for all of it. Phase 2 needs Phase 1 (a harness session id is
the DO id). Phase 3 needs Phase 2 (there is nothing to stream until a turn emits chunks).
Phase 4 needs Phase 1 (per-session sandboxes need per-session ids).

Phase 3 is where the product stops feeling like a chatbot. If you want the visible win
sooner, the minimum path is 0 -> 1 -> 2 -> 3, with 4 and 5 after.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| `ThinkHarness`, `Sessions`, `Streams`, `Tasks` are all marked `@experimental` in 0.28.1 | Pin `agents` to an exact version instead of `"latest"`. The current `package.json` says `"agents": "latest"`, which means any deploy can silently pull a breaking change. Fix this in Phase 0. |
| The router must emit correct OpenAI SSE with `tool_calls` deltas | It already passes `res.body` through untouched when the client asks for `stream: true`. Verify with one curl against a streaming model before Phase 3 starts. If an upstream connection has `forceStream` and mangles deltas, exclude it from the streaming path. |
| Adding `ai@^7` + an OpenAI-compatible provider + `zod@4` | These are new runtime deps in a Worker bundle. Bundle size and cold start need a check. If the AI SDK is unacceptable, the fallback is Phase 2-alt below. |
| Per-session DOs multiply storage and cost | One DO per session is the SDK's intended model ("in the one-object-per-conversation model a Durable Object holds exactly one session"). Add an idle prune: delete sessions untouched for N days, keep the R2 workspace. |
| E2B lease is 300s and the sandbox worker's KV lease is 600s | Already inconsistent. Phase 4 replaces the KV lease with R2 and removes the mismatch. |
| Multi-step loops cost tokens | `maxSteps` per session, compaction at 100k, and a real cheap tier. |

**Phase 2-alt, if you refuse the AI SDK dependency:** keep `FederationAgent extends Agent`,
install `new Sessions()` and `new Streams()` via `this.lifecycle.use(...)`, and write the
loop yourself inside `this.runFiber("turn", ...)` with `ctx.stash()` checkpoints after each
tool call. You get durability, sessions, streaming, and SSE resume from the SDK, and you
keep your own router quirks. You lose Think's per-tool recovery policy, its heartbeat wake
jobs, its turn queue, and its memory-limit breaker, all of which you would have to
reimplement and would likely get wrong. I do not recommend it, but it is a real option and
it is strictly better than what runs today.

---

## 7. Decisions I need from you

1. **ThinkHarness or Phase 2-alt?** Think is the recommendation. Alt avoids the AI SDK.
2. **Which model ids?** Something `zay-router` can actually route. It suggested
   `gemini3.7flash`, `opus5`, `opus5thinking`, `gemini3.8flash`. No `oc/` or `muse-spark`
   ids, per your standing rule. And a genuinely cheaper `MODEL_CHEAP`.
3. **Is `maxSteps` user-controllable in the UI** (a "deep work" toggle) or fixed per route?
4. **R2 for workspaces, agreed?** It needs an R2 bucket created, which is a dashboard or
   wrangler action on your side.
5. **Phase 5 picks.** All eight, or a subset? Notifications and the browser tool are the
   two I would do first.
6. **Does this stay in `repo-clone` and deploy from `project/agent-federation`** per the
   two-tree workflow, and do you still want to push `blip/reconcile-local-deltas` first?

---

## 8. Builder check: holes I found reading this as an implementer

Ruled on here so they do not stall the build. Anything marked **yours** still needs your call.

1. **Where does the session index live?** Ruled: a **registry DO** at
   `idFromName("registry")` with its own SQLite, not KV. KV list reads are eventually
   consistent for up to 60s, so a session you just created would not appear in your own
   sidebar. A DO gives a transactional insert plus an ordered list query.
2. **`EventSource` cannot set an Authorization header.** The WS upgrade already solved
   this at `index.ts:64-72` by also accepting `?token=<AGENT_API_KEY>`. The SSE route must
   do the same, with `safeEq` and fail-closed. Without this Phase 3 cannot authenticate.
3. **How does the client learn the stream id?** Ruled: `POST /api/sessions/:id/message`
   becomes **submit-and-return**, not await-the-reply. It writes the submission durably
   (`harness.submit(...)`, which resolves before the model runs) and returns
   `{ streamId, operationId }` in milliseconds. The client then opens
   `GET /api/sessions/:id/stream/:streamId?token=...`. This matters because a 40-step
   build must never be held inside one HTTP request: the Worker wall clock would kill it
   and today's `await agentStub(env).chat(...)` at `index.ts:96` does exactly that.
4. **What happens to the existing `/api/message`?** It stays as a compatibility alias that
   submits to the session's DO and waits, so the current UI keeps working during Phase 2
   and is cut over in Phase 3. Delete it at the end of Phase 3.
5. **`Env` has no R2 binding.** Phase 4 adds `WORKSPACE_R2: R2Bucket` to `src/types.ts`
   and a bucket to `wrangler.jsonc`. Creating the bucket is a dashboard/wrangler action on
   your side, so it is **yours** (see decision 4).
6. **How does a human answer a durable approval?** Think parks the tool call in the
   transcript awaiting input. The mechanism is `awaitsInput(message)` to detect it and
   `answerToolCall(messages, { type: "approval-response", approvalId, approved, reason })`
   to resolve it, both exported from `agents/harness/ai-sdk`. `/api/approve` becomes a thin
   wrapper over that, and the existing `pending_actions` table plus `approveAction` RPC go
   away. The UI card is unchanged.
7. **Migration of the data already in the `main` DO.** It holds `memories`, `messages`,
   `tasks`, `plan_steps`, `pending_actions`, and `vault_chunks`. Ruled: `main` is **kept**
   and becomes the default session, so existing memory, scheduled jobs, and the 9router
   vault survive untouched. New sessions get new DOs. One-shot copy of `memories` from
   `main` into a session is a later nicety, not a launch blocker.
8. **Where do scheduled jobs live now?** Ruled: **per session DO**. A job belongs to the
   conversation that created it, and the SDK `Scheduler` writes a real Durable Object
   alarm, which wakes an evicted DO on time. `armTick` and `onScheduledTask` move into the
   session DO unchanged, and `schedule_task` enqueues into that session's `tasks` table.
   The registry DO keeps a `session_id` on each listed session so the away timeline can
   still show upcoming work across sessions without opening each one.
9. **E2B sandboxes multiply with sessions.** One sandbox per session costs money and boot
   time. Ruled: cap live sandboxes, reuse one per session with an idle GC (release after
   N minutes idle; the R2 snapshot is the source of truth, so releasing is free), and show
   the restore as a progress widget per Phase 4.4.
10. **`package.json` says `"agents": "latest"`.** Any deploy can silently pull a breaking
    change to experimental APIs. Pin it to `0.28.1` in Phase 0 and bump deliberately.

## 9. What this document is not

It is not approved work. Nothing gets built until you sign off on it. The design of the
UI is unchanged; every widget class in `ui/index.html` stays and gets driven live instead
of rendered once at the end.
