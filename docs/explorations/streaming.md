# Streaming: end-to-end design for token-by-token replies

Read-only exploration. No source file was modified; this is the only file written.
Secrets are referenced by env-var **name** only (`AGENT_API_KEY`, `ROUTER_KEY`, `STATE_KEY`,
`SBOX_TOKEN`, `MODEL_PRIMARY`, `MODEL_CHEAP`, `ROUTER_URL`, `PARALLEL_API_KEY`).

---

## Scope

BLIP has **zero** streaming on every hop today: the console waits for the entire model round
trip (plus a second self-critique round trip) and then paints one finished bubble. This report
traces the full path — UI → brain worker → brain Durable Object → tool loop → zay-router →
upstream provider — and designs `upstream SSE → brain → UI deltas`, covering: tool calls that
arrive as stream deltas (OpenAI `delta.tool_calls` vs Anthropic `content_block_delta`),
partial-markdown rendering against the new `md()` renderer, keeping the non-stream
`POST /api/message` contract for cron/Telegram/one-offs, mid-stream abort, backpressure,
whether the DO can hold an open streaming response, and how the mascot state should track
tokens. Effort is sized S/M/L per item; the riskiest step is called out first.

Out of scope (owned by other explorations): router provider/routing correctness, memory recall
quality, guardrail policy, sandbox semantics.

---

## Current behavior (file:line)

### 1. Brain → router: never asks for a stream

- The only chat call is inside the tool loop: `src/agent.ts:718-728` — `fetch(this.env.ROUTER_URL,
  {method:"POST", headers:{content-type, authorization: Bearer ROUTER_KEY, X-Tier},
  body: JSON.stringify({model, messages: msgs, tools}), signal: AbortSignal.timeout(25_000)})`.
  The body at `src/agent.ts:725` contains **no `stream` key at all** (so the upstream default,
  non-streaming, applies). Precise correction to the brief: `stream:false` is *explicit* only on
  the two auxiliary calls — self-critique `src/agent.ts:996` and the unused mascot decider
  `src/index.ts:164`.
- The response is consumed as one buffered JSON blob: `const data = await response.json()` at
  `src/agent.ts:746`. `RouterChatResponse` (`src/agent.ts:160-171`) only models the
  non-streaming `choices[0].message` shape — there is no delta/chunk type anywhere in `src/`.
- Transport note: `src/agent.ts:718` uses plain `fetch(ROUTER_URL)` even though a same-account
  service binding `ROUTER` → `zay-router` exists (`wrangler.jsonc:12`, declared
  `src/types.ts:68`, and already used in the `/api/decide` pattern `src/index.ts:168-170`). So
  every chat round trip — and, if we flip the flag, every token — currently traverses the public
  `ROUTER_URL` (local omniroute behind a cloudflared quick tunnel), not the edge-native binding.

### 2. The chat + tool loop shape (`src/agent.ts:505-953`)

- Deterministic branches return **before** any model call and are already "instant":
  `run:` `src/agent.ts:541-548`, `search:` `552-567`, capability FAQ `571-591`. These should keep
  a one-shot reply envelope.
- Pre-model work: memory recall `510-523`, history `525-527`, prompt assembly `523`,
  `logMessage(sql,"user",...)` `534`.
- Loop: `for (let round = 0; round < 4; round++)` `src/agent.ts:715` → one router call per round
  (`718`) → `data.choices[0].message` (`747`).
  - If `tool_calls` is absent → `finalText = msg.content`, `break` (`749-752`).
  - Else the assistant turn + tool_calls are pushed back (`753`), each call is executed inline
    (`754-876`: `plan` `771-787`, `plan_done` `788-800`, `schedule_task` `801-821`,
    `save_workspace` `822-840`, `web_search` `841-847`, default `exec` `848-865`), a `ToolRun`
    card is recorded (`869-874`), the tool result is pushed as a `role:"tool"` message (`875`),
    and the loop re-enters the router. Risky `exec` is held (`851-858`) and `break`s the loop
    (`879`).
- So the *visible* assistant text is produced by the **last** round only; every earlier round's
  `msg.content` is discarded (`src/agent.ts:753` pushes it into history but it is never emitted).
  A streamed reply therefore has to be re-emitted per round, not once.
- Held-action path returns early with the approval card (`883-898`).
- Empty result fallback: `src/agent.ts:900`.
- **Self-critique second pass**: `src/agent.ts:905-908` runs `selfCritique()` whenever
  `toolRuns.length > 0`; `selfCritique` is `961-1020` — a second full router call, cheap tier,
  `stream:false` (`996`), `AbortSignal.timeout(20_000)` (`998`), expecting a JSON verdict
  (`1004-1013`) and replacing `finalText` on `verdict:"revise"` (`1014-1018`). Any tool-using
  answer therefore waits **draft round trip + critique round trip** before a single character is
  visible.
- Persistence + envelope: `logMessage(sql,"assistant",finalText,...)` `910`,
  `remember(...,"exchange",...)` `911`, deterministic mascot `state`/`verb` derived by regex over
  `content + finalText` `913-944`, plan read `945`, return `946-952`.
- Worst-case dead air before any bytes reach the browser: 4 × 25 s + 20 s ≈ 120 s
  (`src/agent.ts:727`, `998`); `tests/README.md` documents the live matrix waiting up to
  120 000 ms per probe.

### 3. Brain HTTP surface (`src/index.ts`)

- `POST /api/message` `src/index.ts:59-77`: auth by `AGENT_API_KEY` (`60-63`), body parse
  (`64-72`), `await agentStub(env).chat(...)` (`75`), `return Response.json(result)` (`76`) —
  one full JSON body, no partial delivery. This is the endpoint the UI and the Telegram bridge
  use (`ui/index.html:385`, `deploy/telegram-bridge/src/index.ts:52-59`).
- WebSocket upgrade gate `src/index.ts:42-53`: fires on *any* request with
  `Upgrade: websocket` regardless of path, requires `AGENT_API_KEY` via `Authorization`
  **or** `?token=` (browsers cannot set WS headers) and fails closed when unset (`43-50`), then
  `stub.fetch(request)` on the same `idFromName("main")` id (`22-24`, `51-52`). Frames reach the
  DO through the Agents SDK's own dispatch → `onMessage`.
- Other routes are plain JSON RPC over the stub: `/api/tasks` `79-86`, `/api/plan` `88-95`,
  `/api/approve` `97-113`, `/api/decide` `115-193`, vault `195-287`, static assets fallback
  `290-292`, cron keep-alive `297-307`.

### 4. DO WebSocket handling (`src/agent.ts:311-340`)

`onMessage(connection, message)` parses one JSON frame, supports `{type:"status"}` (`328-331`) and
`{type:"chat", content, tier}` (`332-337`), then **awaits the whole `handleChat`** and sends exactly
one reply frame: `src/agent.ts:338-339`
`connection.send(JSON.stringify({type:"chat", ...reply}))`. There is no intermediate frame, no
`broadcast`, no `@callable` usage anywhere in `src/`, and the SDK frame/RPC protocol is not
exercised. `onMessage` is the only WS hook implemented (`onStart` `212-215`,
`onScheduledTask` `343-386`).

**The console never opens a socket.** `grep` for `new WebSocket` in `ui/index.html` returns
nothing; `send()` (`ui/index.html:384`) calls `fedChat()` (`385`) which does
`fetch(AGENT + "/api/message")`. The gated WS path is currently dead weight.

### 5. zay-router already streams — the KEY INSIGHT, confirmed

`deploy/router-worker/src/index.ts`:

- `ConnectionCfg.forceStream` exists (`:26`) because several free upstream lanes are SSE-native
  (see the hand probe `deploy/probe-session.mjs:25,31` sending `Accept: text/event-stream` +
  `stream:true`).
- The client's own request is read as text and JSON-parsed (`:395-402`); `clientWantedStream` is
  computed as `jsonBody.stream === true` (`:450`).
- Body rewrite preserves the client's `stream` field untouched (`:451-467`); only
  `if (conn.forceStream) nb.stream = true` (`:453`) ever *adds* streaming.
- Passthrough branch (`:486-492`) returns `new Response(res.body, ...)` — the upstream body is
  relayed as a live stream, with hop-by-hop/content-length/content-encoding headers stripped
  (`:176`, `:487-489`) and `x-router-conn` added (`:491`).
- Collapse branch (`:480-485`): aggregates **only** when
  `conn.forceStream && !clientWantedStream && content-type includes event-stream`.
  `aggregateSSE` (`:201-247`) does `await res.text()` (`:203`) — i.e. full buffering — then
  line-splits `data:` chunks and concatenates **only `choices[0].delta.content`** (`:228`).

⇒ **Confirmed: the router can already stream. It only collapses SSE when the client did not ask
for it, and the brain never asks.** A brain-side `stream:true` is a one-field change on the wire
and the router will relay the provider's SSE untouched on non-`forceStream` lanes.

Collateral bug in the collapse path: `aggregateSSE` returns
`{message:{role:"assistant",content}}` (`:241`) with **no `tool_calls`** — streamed
`delta.tool_calls` and `delta.reasoning_content` (declared at `:220`, never read) are dropped.
On a `forceStream` lane that means the brain sees no tool calls and empty content
(`src/agent.ts:749-751`), producing the misleading `"(hit the tool round limit; try a simpler ask)"`
(`src/agent.ts:900`). Also `forward()`'s upstream `fetch` (`:277`) carries no `signal`/timeout.

### 6. Console rendering path (`ui/index.html`)

- `LOG` is an array of `[role, text]` / `["t", toolRun]` tuples (`:344`); `SC.chat()` (`:358`)
  maps it to bubbles: `LOG.map(([r,t],i)=> r==="t" ? toolCard(t) : `<div class="m ${r}${i>=NF?" nw":""}">${md(t)}</div>`)`,
  then appends the busy bubble when `busy`:
  `<div class="m a" id="amsg"><span class="tpk"><i></i><i></i><i></i></span></div>` — the typing
  dots (`:358`, CSS `.tpk` `:126`).
- `renderThread()` (`:375`) is `$("scr").innerHTML = SC.chat()` — a **whole-thread string replace**,
  and `upd()` (`:372-374`) re-injects `#amsg` and calls `scrollEnd()` (`:356`, 80 ms `setTimeout`
  + smooth scroll) on every state change.
- `send()` (`:384`) pushes the user row, sets `cur="think"`, `busy=true`, renders, then
  `fedChat(v)`. **No re-entry guard** while busy.
- `fedChat()` (`:385`) awaits the single JSON, pushes `["a", reply]` **once**, then tool cards,
  `PENDING`, `PLAN`, the final `cur` state, `busy=false`, `renderThread()`, `loadTasks()`.
- Markdown: `esc()` `:326` then `md()` `:327-343` — fenced blocks extracted first by
  `/```[\s\S]*?```/g` (`:328`), inline code `:329`, then a line-based parser for headings/lists/
  paragraphs (`:331-342`). It is a **whole-string** renderer: an unterminated fence does not match
  `:328` and a partial `**bold` stays literal.
- Mascot: state table `PS` (`:217-241`) already has `think`, `write`, `code`, `search`, `data`
  poses; `pose()` (`:352-354`) sets CSS vars; `S[...]` verbs cycle in `tick()` (`:389`, driven by
  `setInterval` `:395`). `.cur` blinking-caret CSS exists at `:108` and is currently unused — free
  real estate for a streaming cursor.
- `AGENT` origin is hardcoded (`:325`), so any new endpoint must be derived from it.
- `README.md:16-25` is stale on this topic (claims "no WebSocket, no markdown renderer", old line
  counts) — do not trust it as streaming evidence.

---

## Problems & risks

- **[Critical] The whole path is buffered twice, so perceived latency is the sum of two model
  round trips.** `src/agent.ts:746` (`response.json()`) + `src/agent.ts:905-908`/`982-999`
  (critique) + `src/index.ts:76` (`Response.json`) + `ui/index.html:385` (single await). Nothing
  can reach the browser earlier without changing all four.
- **[Critical] The quick-tunnel hop is where SSE actually breaks.** Brain→router goes over public
  `ROUTER_URL` (`src/agent.ts:718`) instead of the existing `ROUTER` service binding
  (`wrangler.jsonc:12`, `src/types.ts:68`). Cloudflared quick tunnels are documented to buffer GET
  responses so `text/event-stream` arrives all-at-once rather than incrementally (upstream report
  and workaround: use `POST` or a named tunnel —
  https://github.com/cloudflare/cloudflared/issues/1449). A naive `stream:true` flip can therefore
  look like "streaming doesn't work" while the code is correct. This is the riskiest unknown and
  must be spiked first.
- **[Critical] Tool calls are invisible in the current streaming contract.** `aggregateSSE`
  (`deploy/router-worker/src/index.ts:201-247`) drops `delta.tool_calls` entirely (only `:228`
  `delta.content` is accumulated; `reasoning_content` at `:220` is declared and unused), so any
  `forceStream` lane silently loses tool use and the brain returns the round-limit filler
  (`src/agent.ts:900`). Streaming makes this path hot; it must be fixed before `stream:true` is
  the default.
- **[Major] A stream needs a different timeout model.** `AbortSignal.timeout(25_000)`
  (`src/agent.ts:727`, and `20_000` at `:998`) aborts the *whole* fetch including body reads, so a
  slow 4 000-token answer would be killed mid-stream, and the canned timeout replies
  (`src/agent.ts:733-740`) would land *after* visible text. Needs: time-to-first-token budget +
  inter-delta idle timeout + overall cap, and an "append error, keep partial" contract.
- **[Major] `renderThread()` is a full `innerHTML` replace of the entire thread**
  (`ui/index.html:375-378`) with `md()` re-parsing every message (`:327-343`) plus
  `scrollEnd()` (`:356`). Naive per-token re-render is O(n²) in message length, kills scroll
  position, re-fires the `nw` entrance animation (`:358`, `:53`) on every frame, and re-runs the
  `pop`/`in` keyframes — visible flicker. Deltas need a dedicated append target (`#amsg`) and a
  single final markdown pass.
- **[Major] Partial markdown is wrong by construction.** An unclosed fence is not matched by the
  fence regex (`ui/index.html:328`), so half-typed code blocks render as prose and a dangling
  `` ``` `` becomes literal text; unclosed `**`/`` ` `` render literally. Streaming markdown must
  either stay plain-text until `done`, or auto-close open constructs.
- **[Major] Single "main" DO + long handlers = interleaved turns.** All routes use
  `idFromName("main")` (`src/index.ts:22-24`). Streaming lengthens handler wall time from ~1-25 s
  to minutes, while `send()` has no busy guard (`ui/index.html:384`) and `handleChat` has no
  turn lock. Shared mutable state makes this visible: `setPlan` does `DELETE FROM plan_steps` +
  re-insert (`src/memory.ts:216-225`), so a second concurrent turn erases the first one's
  checklist mid-stream; `recentMessages` orders by `created_at DESC, id DESC` (`src/memory.ts:144-150`)
  so interleaved `logMessage` rows (`:128-141`) can reorder the model's own history.
- **[Major] Tool-call arguments must not be streamed as text, and the guardrail only knows the
  command when the JSON is complete.** `isRisky(cmd)` runs on fully-parsed args
  (`src/agent.ts:759-760`, `851`). If a design echoes `delta.tool_calls[i].function.arguments`
  fragments into the chat, a high-risk command would be displayed *before* the hold decision, and
  `msg.content` from a tool round is currently thrown away (`src/agent.ts:753`), so the last-round
  rule ("never reply with a plan you are not executing", `src/agent.ts:63`) needs re-stating.
- **[Major] Cancel semantics are undefined at three layers.** No `signal` on the router's upstream
  fetch (`deploy/router-worker/src/index.ts:277`); `execSandbox` cannot be interrupted
  (`src/agent.ts:468-503`, sandbox worker has no kill route —
  `deploy/sandbox-worker/src/index.ts` only exposes JSON endpoints); no Stop button in the UI
  (`ui/index.html:384-385`). A browser abort must still persist the partial reply
  (`src/agent.ts:910-911` runs only on success).
- **[Minor] Two transports exist and the console uses neither of the streaming ones.** WS gate is
  implemented and authenticated (`src/index.ts:42-53`) but unused by the UI; `onMessage` sends one
  terminal frame (`src/agent.ts:338-339`). Choosing SSE means the unused WS path stays dead;
  choosing WS means the upgrade is accepted on *any* path (`src/index.ts:42`) while SDK routing is
  documented around `/agents/{agent}/{instance}` — verify the SDK completes the hibernation
  handshake for a bare `/` upgrade before relying on it.
- **[Minor] If `EventSource` were used, auth would leak into the URL.** The existing WS gate
  already accepts `?token=AGENT_API_KEY` (`src/index.ts:47-48`); `EventSource` cannot set headers,
  so it would push the secret into URLs/logs/Referer. Use `fetch` + `response.body.getReader()`.
- **[Minor] `POST /api/decide` (`src/index.ts:115-193`) is dead code that also contains a `__debug_url`
  router probe (`src/index.ts:129-139`); mascot state is now computed deterministically
  (`src/agent.ts:913-944`). Delete it or it becomes a second, contradicting state source for the
  streaming UI.
- **[Minor] The router never reads the `X-Tier` header the brain sends** (`src/agent.ts:723` vs
  `grep -n X-Tier deploy/router-worker/src/index.ts` → no match), and the router's
  Anthropic-kind branch (`:404-406`, `:425-426`) is selected by the *client's* path, so the brain
  (OpenAI-format, `/v1/chat/completions`) must assume OpenAI chunk shapes and stay defensive about
  lanes whose upstream emits Anthropic/Gemini events.
- **[Minor] `README.md:16-25` documents the HTTP surface with superseded line numbers and claims no
  markdown renderer exists** — misleading input for a streaming design doc.

---

## Near-term improvements

Ship these first; each is small, independent, and makes the streaming work safe instead of lucky.

1. **Spike: does SSE actually flow today?** (riskiest step, do first). With the router already
   able to passthrough (`deploy/router-worker/src/index.ts:486-492`), issue one
   `stream:true` `POST /v1/chat/completions` (a) direct to `ROUTER_URL` through the cloudflared
   quick tunnel and (b) via the `ROUTER` service binding (`wrangler.jsonc:12`, pattern at
   `src/index.ts:168-170`), and time each received `data:` line. If (a) arrives as one lump, the
   tunnel buffers (https://github.com/cloudflare/cloudflared/issues/1449) and streaming must be
   built on the service binding / a named tunnel. No product code required: a probe script under
   `tests/` or `wrangler dev`.
2. **Point chat at the `ROUTER` binding when present.** Same pattern already proven at
   `src/index.ts:168-170`; removes the public tunnel from the token path and cuts a
   workers.dev fetch-challenge surface. Keep `ROUTER_URL` fallback for `wrangler dev`
   (README.md:76-79 notes bindings don't resolve standalone).
3. **Fix `aggregateSSE` to reconstruct `tool_calls` (and `finish_reason:"tool_calls"`).**
   Accumulate `delta.tool_calls[]` keyed by `index` (`id` + `function.name` arrive once,
   `function.arguments` concatenates), emit them in `message.tool_calls`, and also concatenate
   `reasoning_content` (`deploy/router-worker/src/index.ts:220,228,241`). Restores tool use on
   `forceStream` lanes and un-breaks the misleading filler at `src/agent.ts:900`.
4. **Adopt the service binding + a `callRouter(body)` helper in the brain** so the streaming and
   non-streaming variants share headers, auth, tier mapping (`src/agent.ts:412-417`), and one
   timeout policy. Today the request literal is duplicated at `src/agent.ts:718-728`,
   `src/agent.ts:982-999`, `src/index.ts:150-170`.
5. **UI hygiene that streaming needs anyway:** guard `send()` while `busy` (`ui/index.html:384`),
   make `scrollEnd()` only auto-scroll when the user is already near the bottom
   (`ui/index.html:356`), and stop re-firing the `nw` entrance animation for a growing bubble
   (`ui/index.html:358`, `:53`).
6. **Reclaim the dead code**: delete `POST /api/decide` (`src/index.ts:115-193`) and its
   `__debug_url` probe, and refresh `README.md:16-41` (route table + "no markdown renderer").
7. **Give the console live progress without any streaming protocol** (1-day win for the #1
   complaint): today `src/agent.ts:311-340` could emit `{type:"tool", card}` frames, but since the
   UI doesn't use WS, the cheap version is a poll — `/api/plan` (`src/index.ts:88-95`) already
   returns plan + held action; poll it every ~2 s while `busy` so the checklist ticks and the
   mascot can pose `code`/`search` mid-turn.

---

## Next features

### F1 — Turn engine with an injectable `emit` sink (foundation, no behavior change)

- **What:** refactor `handleChat` (`src/agent.ts:505-953`) into `runTurn(content, tier, emit)` where
  `emit(ev)` receives `state | delta | tool_start | tool_end | plan | pending | done | error`, and
  `chat()` (`src/agent.ts:218-224`) passes a no-op sink that collects the same `AgentReply`
  (`src/types.ts:28-40`) as today. `onMessage` and the new SSE route become thin adapters.
- **Why:** one code path serves WS, SSE and the buffered JSON used by cron
  (`src/agent.ts:354`), Telegram (`deploy/telegram-bridge/src/index.ts:52`), and
  `POST /api/message` (`src/index.ts:75`). Without this, streaming becomes a forked copy of the
  loop and the tool/guardrail logic drifts.
- **Design sketch:** keep the 4-round loop and every branch intact; deltas come only from the
  *final* text-producing round plus optional per-round commentary; `emit({type:"delta",text})`
  inside the SSE reader; persistence (`logMessage` `src/agent.ts:910`, `remember` `:911`) moves
  into a `finally` so an aborted turn still stores its partial text with an `[interrupted]` marker;
  `state` events fire at the real moment (tool start → `code`/`search`/`schedule`, text flowing →
  `write`, pending → `approve`) instead of the post-hoc regex at `src/agent.ts:913-944`, which
  becomes the fallback for the buffered path.
- **Effort: M.** **Dependencies:** none. **Risk:** low-medium — a mechanical refactor of a 450-line
  function with only `tests/live-matrix.mjs` as a safety net; add unit tests for the SSE parser and
  the round machine first.

### F2 — OpenAI-SSE client in the brain (stream parser + delta assembly)

- **What:** `callRouterStream(body, handlers)` — POST with `stream:true`, read
  `res.body.getReader()`, decode with `TextDecoder`, split on `\n\n`, keep a residual buffer for
  partial lines, ignore `: comment`/`event:` lines, stop at `data: [DONE]`.
- **Why:** the router relays untouched (`deploy/router-worker/src/index.ts:486-492`), so the brain
  must own chunk semantics.
- **Design sketch:** handle `choices[0].delta.content` → `emit delta`;
  `delta.tool_calls[{index, id, function:{name, arguments}}]` accumulated **per `index`** into
  complete `tc` objects (OpenAI sends `id`/`name` once and `arguments` in fragments —
  https://developers.openai.com/api/docs/guides/function-calling); `delta.reasoning_content` →
  optional "thinking" channel; `finish_reason` `tool_calls|stop|length` decides loop vs final.
  Add a shape guard: if the first payload has `type:"content_block_start"` /
  `content_block_delta` it is an **Anthropic** stream (`message_start`, `content_block_start`,
  `content_block_delta` with `text_delta` / `input_json_delta.partial_json` / `thinking_delta`,
  `content_block_stop`, `message_delta` carrying `stop_reason`, `message_stop`, `ping`, `error` —
  https://platform.claude.com/docs/en/api/messages-streaming): map `text_delta`→delta,
  accumulate `partial_json` per `index` for `tool_use`; never forward raw `input_json_delta` to
  the UI. Non-2xx mid-stream arrives as an SSE `error` event or a plain JSON body — detect
  `content-type` before parsing.
- **Effort: M.** **Dependencies:** F1, spike S1, F3 (router aggregate fix if any lane is
  `forceStream`). **Risk:** medium — the `arguments` concatenation and the provider-shape branch
  are where silent breakage lives; test against at least two real lanes.

### F3 — Router: make streaming a first-class contract

- **What:** (a) the `aggregateSSE` tool_calls/reasoning fix from near-term 3; (b) optional
  `?stream`-agnostic normalization so a non-streaming client can request OpenAI shape even on
  Anthropic-shaped lanes; (c) honor `request.signal`/timeout in `forward()`
  (`deploy/router-worker/src/index.ts:277`).
- **Why:** the router is the only place that knows each lane's true event vocabulary; keeping the
  brain guessing per-lane is the fragile design.
- **Effort: M.** **Dependencies:** none for (a)/(c); (b) needs the lane inventory (KV
  `router:config` — existence only, values unreadable here). **Risk:** medium — this worker serves
  other consumers; changing aggregate output shape can break `deploy/probe-session.mjs`-style
  tooling. Ship (a) only, additive.

### F4 — SSE endpoint from brain to UI: `POST /api/stream`

- **What:** worker route that auth-checks `AGENT_API_KEY` via `Authorization` header, then
  `return stub.fetch(new Request(...))`; the DO's `onRequest`/`fetch` builds a
  `ReadableStream` of `data: {json}\n\n` frames with
  `content-type: text/event-stream`, `cache-control: no-cache, no-transform`,
  `x-accel-buffering: no` and streams `runTurn` events, ending with the full `AgentReply` frame.
- **Why:** this is the transport the dependency-free single-file console can actually use
  (`fetch` + `getReader()`), it keeps the secret in a header (unlike `EventSource`/`?token=`), and
  DOs returning streaming `Response`s with cancellation propagating to the DO is a documented
  pattern (https://developers.cloudflare.com/durable-objects/examples/readable-stream/,
  https://developers.cloudflare.com/agents/runtime/communication/http-sse/, routing
  https://developers.cloudflare.com/agents/runtime/communication/routing/).
- **Design sketch:**
  - **Can the DO hold an open response?** Yes — the worker returns the DO's `Response` body
    untouched; the DO stays alive while a handler is in flight. Budget: HTTP requests get 30 s CPU
    by default (configurable to 5 min) and **no hard wall-clock limit** for streaming, i.e. the
    constraint is CPU, not elapsed time
    (https://developers.cloudflare.com/workers/platform/limits/,
    https://developers.cloudflare.com/durable-objects/platform/limits/). Parsing per-token JSON is
    cheap but not free: batch/coalesce in the writer and avoid `this.sql` writes per token
    (`src/memory.ts:128-141` per row, and `db()` re-checks schema flags at `src/agent.ts:203-208`).
    A very long stream can also cross the DO's idle-eviction window only *after* the handler
    returns, so nothing may depend on in-memory post-stream state; hibernation and eviction drop
    in-memory vars (https://developers.cloudflare.com/agents/runtime/lifecycle/agent-class/).
  - **Backpressure:** pull-based `ReadableStream.start(controller)`; after each
    `controller.write(...)` `await controller.ready` when queue size grows past ~32 frames, and
    coalesce text deltas server-side (~40-60 ms) so a chatty model can't outrun a slow client.
    Wire `controller.abort()`/`cancel()` → the internal `AbortController` → the router fetch signal.
  - **Abort/cancel:** client `AbortController` on the `fetch` → `request.signal` reaches the DO;
    on `cancel`, stop reading upstream, drain/`releaseLock`, `emit({type:"aborted"})`, persist the
    partial. `waitUntil` can finish cleanup after the client is gone but only briefly
    (~30 s post-response, https://developers.cloudflare.com/workers/platform/limits/). Sandbox
    commands already launched keep running (`src/agent.ts:468-503` has no kill path) — treat "stop"
    as "stop generating", and say so in the UI.
  - **Heartbeat:** emit `: ping\n\n` every ~10-15 s during tool execution so tunnels/CDNs and the
    browser don't idle-kill the socket while no tokens flow (the tool loop is the silent phase:
    `src/agent.ts:754-876`).
  - **Resumability (later):** SDK resumable streaming exists for `AIChatAgent` in `agents` v0.2.24+
    (https://developers.cloudflare.com/changelog/post/2025-11-26-agents-resumable-streaming/);
    hand-rolled version = keep the last N frames + ids in DO memory, honor `Last-Event-ID`.
  - **Multi-connection:** two tabs = two concurrent DO handlers; add a single-flight turn queue
    (second `POST /api/stream` joins the active stream rather than starting a second `handleChat`)
    plus a `turnId` echoed in every frame so the UI drops stale deltas. This is required because of
    the shared mutable plan/messages state (`src/memory.ts:216-225`, `:144-150`).
- **Effort: L** (engine + transport + UI + abort/queue + tests). **Dependencies:** F1, F2, spike S1.
  **Risk:** highest on the tunnel/CDN buffering and the 30 s CPU budget; second on interleaved
  turns.

### F5 — WebSocket streaming (cancel + background push), reusing the existing gate

- **What:** keep the already-authenticated upgrade (`src/index.ts:42-53`) and change
  `onMessage` (`src/agent.ts:311-340`) to `await this.runTurn(content, tier, ev => connection.send(JSON.stringify(ev)))`
  with the same frame vocabulary as F4, and accept `{type:"abort", turnId}` inbound. The final
  `{type:"chat", ...AgentReply}` frame (`src/agent.ts:339`) stays for back-compat.
- **Why:** WS is the only transport with a client→server cancel channel already wired and gated
  here, and it is the natural pipe for *unsolicited* pushes (scheduled-task results logged at
  `src/agent.ts:354-356`, plan-step updates, approval cards) that SSE cannot do without a second
  connection.
- **Design sketch:** UI keeps one long-lived socket (derive it from `AGENT` `ui/index.html:325`,
  `wss:` + `?token=` as the gate already expects `src/index.ts:47-48`), reconnect with backoff,
  re-request `/api/plan` (`src/index.ts:88-95`) on resume. Optionally adopt the SDK's
  `@callable({streaming:true})` + `StreamingResponse` (`stream.send` / `stream.end` /
  `stream.error`) and the client `agent.call("method", args, {onChunk,onDone,onError})`
  (https://developers.cloudflare.com/agents/runtime/lifecycle/callable-methods/,
  https://developers.cloudflare.com/agents/communication-channels/chat/client-sdk/) — but that
  needs a bundled/CDN client in a zero-dependency single-file page and TC39 decorators
  (`tsconfig.json:3` `target:"ESNext"` is fine; do **not** enable `experimentalDecorators`), so
  treat SDK-RPC as an adoption decision, not a prerequisite.
- **Effort: M** on top of F1/F2 (the hard part is shared), **L** if the SDK client is adopted.
  **Dependencies:** F1, F2. **Risk:** verify the hibernation handshake on a bare `/` upgrade path
  (the gate matches on the header only, `src/index.ts:42`) and that it binds to the same
  `idFromName("main")` instance the HTTP routes use (`src/index.ts:22-24,51`) — otherwise sockets
  and HTTP talk to two DOs with two SQLite DBs and memory silently diverges.

### F6 — Streaming UI: live bubble + caret + deferred markdown

- **What:** replace the typing-dots bubble with the delta target, then re-render once at the end.
- **Why:** `busy` + `#amsg` + `.tpk` (`ui/index.html:358,374`, CSS `:126`) already model "an answer
  is coming"; and `renderThread()`/`md()` must not run per token (`:375`, `:327-343`).
- **Design sketch:**
  - Keep `LOG` as the committed transcript; while streaming, write into a separate
    `STREAM` string rendered inside `#amsg` as **escaped plain text** (`esc()` `:326`) with
    `white-space:pre-wrap` plus the existing `.cur` caret (`:108`) — no markdown until `done`.
  - On `done`, push `["a", fullText]` into `LOG`, clear `STREAM`, `renderThread()` once (so `md()`
    `:327-343` sees a complete string and fences/list state are well-formed), then
    `loadTasks()`/`loadPlan()`.
  - Batch deltas with `requestAnimationFrame` (or ~80 ms) flushes; only auto-scroll when the user
    is near the bottom (fix `scrollEnd()` `:356` first).
  - Optional (F7): a "raw/final" toggle or a `streamMarkdown` mode that feeds `md()` a
    *closed-fence projection* — count `` ``` `` occurrences, and if odd append a synthetic closing
    fence and truncate the trailing partial inline-code/backtick token. This keeps headings/lists
    live but must tolerate the `:328` regex's whole-string assumptions; re-render at most every
    ~150 ms and only the last bubble.
  - Tool frames render as `toolCard()` rows (`:357`) *during* the turn, in arrival order, so
    `exec` output appears while the model keeps talking; approve cards reuse `PENDING`/`decide()`
    (`:309`, `:388`).
  - A Stop button calls `abortController.abort()`, keeps the partial text, and sets `busy=false`.
- **Effort: M.** **Dependencies:** F4 or F5. **Risk:** low-medium — flicker/scroll regressions are
  the realistic failure mode (the `nw` animation `:358` + `:53` and the smooth-scroll timer `:356`).

### F7 — Mascot + "typing" state driven by real events

- **What:** map emitted events to poses instead of guessing after the fact.
- **Why:** today `cur` is a single regex over `content + finalText` computed at the *end*
  (`src/agent.ts:913-944`), while the UI optimistically sets `cur="think"` on send
  (`ui/index.html:384`) and the LLM decider that used to drive this is dead code
  (`src/index.ts:115-193`).
- **Design sketch:** event → state: turn start → `think` (PS `:219`); tool start → `code` (exec),
  `search` (web_search), `memory`/`data` (plan/schedule/save), `approve` when a command is held
  (`src/agent.ts:851-858`); first text delta → `write` (PS `:336`, purpose-built for typing) with
  the verb pill (`:389` `tick()`, `#verb`/`#clk`) showing a live "writing…" + token count;
  `done` → `success`, `error`/timeout → `error`, `aborted` → `idle`. `pose()` (`:352-354`) is
  already idempotent and cheap; throttle pose switches to ≥1 per ~300 ms so a fast tool burst
  can't strobe, and let a server-sent `verb` override the rotating verbs for that state.
- **Effort: S-M.** **Dependencies:** F1, F6. **Risk:** low.

### F8 — Keep the buffered path for jobs that have no viewer

- **What:** `POST /api/message` (`src/index.ts:59-77`) and `chat()` (`src/agent.ts:218-224`) stay
  exactly as they are (buffered), with the deterministic branches (`src/agent.ts:541-591`) and
  self-critique (`:905-908`) untouched; streaming is an additional transport, never a replacement.
- **Why:** cron jobs (`src/agent.ts:343-386` → `handleChat(instructions,"cheap")`), the Telegram
  bridge (`deploy/telegram-bridge/src/index.ts:52-73`, which chunk-sends one 3 900-char message),
  and `tests/live-matrix.mjs` all consume the full JSON envelope (`src/types.ts:28-40`). A DO
  handler with nobody listening should not pay SSE framing cost, and a stream that outlives its
  client must not be the durability mechanism for a job.
- **Design sketch:** one engine, three sinks (buffered / SSE / WS). Self-critique stays buffered
  even on the streaming path — but see F9 for where it moves.
- **Effort: S** (mostly "don't break it"); covered by keeping `tests/live-matrix.mjs` green.
  **Dependencies:** F1. **Risk:** low, but this is the highest-regret area if the shared refactor
  changes the envelope — pin the `AgentReply` shape with a test.

### F9 — Self-critique retiming (the other half of perceived latency)

- **What:** stop making the user wait for the review round trip; either (a) stream the draft live
  and, if `verdict:"revise"`, emit a `revised` frame that swaps the bubble (with an "edited" mark),
  or (b) run critique *while* the draft streams and only swap before commit, or (c) demote it to a
  background memory-writing pass.
- **Why:** `src/agent.ts:905-908` + `961-1020` doubles time-to-first-visible-token for every
  tool-using turn even after streaming lands, because the critique must finish before `logMessage`
  and the return.
- **Effort: M** (a) / **L** (b). **Dependencies:** F1, F4/F5, F6. **Risk:** medium and *product*
  rather than technical — (a) shows then retracts text, which some users read as the agent being
  wrong twice; needs an explicit decision (see Open questions).

### F10 — Cancellation plumbing through the sandbox

- **What:** give `exec` a kill path (sandbox worker route + token'd cancel) and pass
  `AbortSignal` into `execSandbox` (`src/agent.ts:468-503`) and `webSearch` (`:438-447`, currently
  a fixed 20 s timeout).
- **Why:** "Stop" that cannot stop a 60 s shell command is a false affordance, and the tool loop is
  exactly the silent window where users press Stop.
- **Effort: M-L** (touches `deploy/sandbox-worker`). **Dependencies:** F4/F5. **Risk:** medium —
  orphaned processes and partial workspace state.

---

## Open questions for the user

1. **Spike result decides the architecture:** is `ROUTER_URL` still the cloudflared quick tunnel
   (which is documented to buffer GET SSE — https://github.com/cloudflare/cloudflared/issues/1449),
   or can we cut chat over to the `ROUTER` service binding (`wrangler.jsonc:12`) now? If the tunnel
   must stay, do you accept POST-based SSE or a named tunnel as the fix?
2. **Transport:** SSE (`POST /api/stream`) for simplicity in a zero-dependency single-file UI, or
   WebSocket (existing gate `src/index.ts:42-53`) to also get mid-stream Stop, background pushes of
   cron results (`src/agent.ts:354-356`) and multi-tab sync? Or both, with WS second?
3. **Self-critique:** show the draft immediately and silently replace it when the review revises
   (fastest, but visible retraction), keep the current wait-for-review behavior, or move critique to
   a background pass that only writes memory?
4. **Partial markdown:** plain text + caret until `done` (robust, one clean re-render), or live
   markdown with auto-closed fences (prettier, more re-render work and edge cases)?
5. **Concurrency model:** one "main" DO means concurrent turns interleave and the shared plan table
   gets wiped by `setPlan` (`src/memory.ts:216-225`). Serialize turns (single-flight queue, second
   tab joins the stream), or is multi-conversation (per-thread DO ids) finally on the table?
6. **Tool-arg visibility:** during a streamed `exec` call, may the UI show the command as it types
   out (`src/agent.ts:851` only decides risk once the JSON is complete), or must it show only the
   tool name until the hold/run verdict?
7. **Abort semantics:** "Stop" stops generation but cannot stop a running sandbox command until
   F10 exists — acceptable? And on abort, do you want the partial answer persisted into
   `messages`/memory (`src/agent.ts:910-911`) or discarded?
8. **Non-console channels:** Telegram (`deploy/telegram-bridge/src/index.ts:52-73`) stays
   buffered, or do you want pseudo-streaming there via throttled `editMessageText`?
9. **Budget:** acceptable to raise DO CPU beyond the 30 s default (up to 5 min) for long streams
   (https://developers.cloudflare.com/durable-objects/platform/limits/), and are you OK with
   `wrangler.jsonc` gaining `compatibility_flags = ["nodejs_compat"]` (README.md:74-78 says it is
   still missing even though `src/agent.ts:1` imports the SDK)?
10. **Cleanup permission:** delete `POST /api/decide` (`src/index.ts:115-193`, incl. the
    `__debug_url` probe at `:129-139`) and the stale `README.md:16-41` route table as part of this
    work?

---

## Sources consulted (public docs)

- Durable Objects streaming a `ReadableStream` back to a Worker, incl. abort propagation:
  https://developers.cloudflare.com/durable-objects/examples/readable-stream/
- Durable Object platform limits (CPU 30 s default / up to 5 min, alarms, storage):
  https://developers.cloudflare.com/durable-objects/platform/limits/
- Workers platform limits (CPU per request, no hard HTTP duration limit, subrequests, `waitUntil`):
  https://developers.cloudflare.com/workers/platform/limits/
- Agents SDK — HTTP and Server-Sent Events:
  https://developers.cloudflare.com/agents/runtime/communication/http-sse/
- Agents SDK — routing (`routeAgentRequest`, `/agents/{agent}/{instance}`):
  https://developers.cloudflare.com/agents/runtime/communication/routing/
- Agents SDK — callable methods (`@callable`, `@callable({streaming:true})`,
  `StreamingResponse.send/end/error`, JSON-serializable args, connection-closed rejections):
  https://developers.cloudflare.com/agents/runtime/lifecycle/callable-methods/
- Agents SDK — Agent class internals (hooks `onStart/onRequest/onConnect/onMessage/onClose`,
  hibernation default `true`, `connection.send` / `this.broadcast`):
  https://developers.cloudflare.com/agents/runtime/lifecycle/agent-class/ and
  https://developers.cloudflare.com/agents/runtime/communication/websockets/
- Agents SDK changelog — resumable streaming (`AIChatAgent`, v0.2.24):
  https://developers.cloudflare.com/changelog/post/2025-11-26-agents-resumable-streaming/
- Agents client SDK — `agent.call(method, args, {onChunk,onDone,onError})`:
  https://developers.cloudflare.com/agents/communication-channels/chat/client-sdk/
- OpenAI function calling / streamed `delta.tool_calls` accumulation:
  https://developers.openai.com/api/docs/guides/function-calling
- Anthropic Messages streaming event vocabulary (`content_block_delta`, `input_json_delta`,
  `partial_json`, `message_delta.stop_reason`):
  https://platform.claude.com/docs/en/api/messages-streaming
- cloudflared quick tunnel buffering SSE on GET (workaround: POST or named tunnel):
  https://github.com/cloudflare/cloudflared/issues/1449
