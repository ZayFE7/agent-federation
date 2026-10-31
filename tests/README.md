# tests/

Sixty-nine offline, framework-free test files live here, all run by `npm test`. Beside them are the
runner, one shared fixture, and six live-only scripts that `npm test` never runs.

The count is whatever is on disk, not a number baked into a file: `run-all.mjs` globs
`tests/*.test.mjs`, so adding a file adds it to the suite with no edit. As written here there are
69 such files.

## How the suite runs

- `npm test` is `node tests/run-all.mjs`.
- `run-all.mjs` excludes itself, spawns `node <file>` per match with `stdio: "inherit"`, prints
  `PASS tests/<file>` or `FAIL tests/<file>` per child, then prints `<n>/<total> files passed`, and
  exits 1 if any child exited non-zero or if nothing matched.
- No framework, no build step, no CI: there is no `vitest`/`jest`/`playwright` dependency and no
  `.github/` or workflow file anywhere in the project.
- An offline test runs on plain Node. Node 22.6+ strips the TypeScript types from a `../src/*.ts`
  import at load, so the tests that import a `.ts` module need nothing else; those modules are kept
  dependency-free by design so they stay loadable this way.
- The live scripts (`live-matrix.mjs`, `live-stream.mjs`, `live-probe.sh`, `router-probe.mjs`,
  `capture-ui.mjs`, `live-automations.mjs`) do not end in `.test.mjs`, so they are outside the glob
  and `npm test` makes no network call.

Run any single file directly with `node tests/<file>.test.mjs`. Every file exits 0 on success and
prints every failure then exits 1 otherwise.

## Offline tests, file by file

Each line states what the file asserts, that it runs under `npm test` (or `node tests/<file>`), and
what it cannot reach.

### approval.test.mjs
Asserts only shell (`exec`) can be flagged risky and that a malformed exec input fails closed.
Covers ordinary code staying ungated, critical effects gating, malformed exec input failing closed,
and `parkedApproval`, the transcript scan a reloaded console uses to re-mount its gate. Cannot reach
the live approval round trip: that needs a Durable Object and is only exercised live.

### automation-engine.test.mjs
Runs the real `AutomationEngine` against a real `node:sqlite` store and fake session/fetch ports.
Covers wrong secrets, duplicate delivery ids, queued to running to done, condition skips, cooldown
rate limits, watcher seed/change behavior, schedule due advancement, and target-session rejection.
Cannot reach the AutomationAgent alarm or a live model turn; `live-automations.mjs` owns that.

### automation-match.test.mjs
Pins the data-only condition matcher: all/any, dotted and indexed paths, each operator, missing-path
semantics, depth and node caps, and rejection of unknown operators. No code execution.

### automation-routes.test.mjs
Pins public hook authentication and the bearer-gated management family: accepted, duplicate, invalid,
oversized, rate-limited, create-once secret, list redaction, reserved-path ordering, control actions,
and invalid ids.

### automation-security.test.mjs
Pins 32-byte base64url secrets, hints, constant-time comparisons, GitHub HMAC (including rejected
SHA1), body caps, URL/SSRF guards, and header redaction.

### automation-schedule.test.mjs
Pins interval floors, UTC daily rollover, stable JSON, watcher fingerprints, excerpts, and source
validation.

### automation-store.test.mjs
Pins the automation tables, unique delivery key, rate counters, watch state, retention pruning, and
the private columns. It never starts a DO.

### automation-agent.test.mjs
Source-level guards for the session origin path: automation turns cannot use directives, parked
approvals do not report completion, and the callback/turnStatus hooks exist. `src/agent.ts` cannot be
imported offline.

### automation-ui.test.mjs
Reads the shipped single-file console and pins the Automations nav, Triggers/Scheduled sections,
create fields for all four sources, the secret-once and rotate flows, event/run timelines, global
pause, Activity card, attention badge, visibility-gated polling, and the mobile sheet. It extracts the
one inline script to a temp file and runs `node --check` on it. It does not drive a browser; the live
UI is a separate manual/Playwright pass.

### child.test.mjs
Pins the sub-agent recursion guard from the outside: the child tool list in `src/capabilities.ts`,
the exact set `src/tools.ts` produces from it, and that even a caller naming `delegate` gets no
delegate tool; then `childEventToParentFrames` in `src/frames.ts` (drops, clip notices, empty call
id). `src/child.ts` is not importable offline, so it is tested through the seams that build it.

### context.test.mjs
Asserts every capability claim renders from the one table in `src/capabilities.ts` and that memory
sits after the tool guidance in the assembled system prompt, including the work rule that asks for a
one-line preamble before the first tool call and forbids ending a turn on a promise. Does not model
the runtime prompt.

### continuation.test.mjs
Contract tests for `src/continuation.ts`, the loop's completion guard: it catches a final sentence
that promises an action ("I'll rerun that part"), a present-progressive one ("I'm checking..."), and
an explicit "not yet", while refusing questions, offers, completed answers, and replies from turns
that used no tool. Also pins the two-retry gate, the silent-stop rule, and the server-authored
continuation instruction. Does not run a model; the live probe in `07-verification.md` is the
end-to-end evidence.

### fake-sql.test.mjs
Contract test for the `fake-sql.mjs` fixture: statement order, the reply log, `rows.slice()` copy
semantics, first-needle-wins, SELECT-only answering, and that a reply is exactly `{ results }` with
no affected-row count (the platform cursor has none, R37). Proves the fixture, not any store.

### frames.test.mjs
Tests the wire vocabulary in `src/frames.ts`: the tool-to-widget table, the chunk-to-frame mapping,
the persisted-message mapping (a parked approval and a finished tool result both survive as frames),
and the one-line SSE encoding. Does not render anything; the console is separate.

### gmail-client.test.mjs
Pins the Gmail API client and MIME layer: thread search metadata, full thread parsing, text/HTML/attachments, base64url, label operations, trash/delete shapes, text/HTML/attachment MIME build, reply headers, caps, and 401/403/429 error redaction. Fake fetch only.

### gmail-routes.test.mjs
Pins the Google connection routes: owner bearer for management, public state-protected callback, start URL and redirect URI, account/default/delete forwarding, missing token fields, and redirects that never carry credentials.

### gmail-ui.test.mjs
Reads the shipped console and pins the Connections page: Gmail accounts, setup card and exact redirect URI, Testing-mode warning, connect/reconnect/default/disconnect, MCP section moved out of Settings, empty/error states, mobile layout, and script syntax.

### google-oauth.test.mjs
Pins Google auth URL parameters, token exchange and refresh forms, userinfo, revoke, invalid_grant classification, and credential redaction. Fake fetch only.

### google-store.test.mjs
Pins the Google account and OAuth state tables with `node:sqlite`: single-use state, expiry, upsert and reconnect by Google sub, default promotion, delete promotion, public redaction, and id/email resolution.

### guardrails.test.mjs
Unit tests `isRisky` in `src/guardrails.ts`: ordinary sandbox code and build-output deletes are free; outward publish/push, payments, outbound uploads, persistent workspace deletes and VM/disk destruction are critical. Cannot catch a
semantic bypass the regex layer was never designed to see.

### harness.test.mjs
Tests `src/harness-config.ts`, our options object, not the SDK's behaviour: the step budget, the
session-bound tool factory, the approval hook, and the recovery numbers. It deliberately keeps `Env`
and zod out of this path, so it asserts shapes and numbers, not SDK internals.

### markdown.test.mjs
Reads `../ui/index.html`, extracts the shipped `esc()` and `md()` bodies by source anchor, evals
them, and asserts the produced HTML (fences, inline code, bold/italic, headings, lists, safe links,
`javascript:` rejection, script/img escaping, no formatting in code spans, paragraph split). This is
the XSS and correctness gate for chat markdown; a rename that breaks the extraction fails here.

### memory.test.mjs
Compiles `src/memory.ts` with esbuild and drives the real exports against a live `node:sqlite`
database: text recall ordering and the one-off prune. esbuild is located by an ordered existence
check (env `BLIP_DEPLOY_NM`, this tree, the sibling tree). Cannot reach embedding recall; that is a
held path (see below), so it tests the LIKE behaviour that shipped.

### mcp.test.mjs
Tests the MCP management routes: authentication, HTTPS and private-host refusal, header and origin
forwarding to the main DO, the unauthenticated OAuth callback hop, list/reconnect/call/delete, and
the exact arguments each call carries. It uses a fake main DO, not a real MCP server; the live
DeepWiki round trip is the external evidence.

### model-settings.test.mjs
Tests the provider settings layer: HTTPS and private-host validation for base URLs, model id
validation, AES-GCM round trips for provider keys, the pure provider store on real SQLite, masked
settings responses, provider create/update routing, default validation and the per-chat provider
parser. Does not call a real provider; the Test button is a live path.

### no-drift.test.mjs
Proves the capability copy a user reads has one source (`src/capabilities.ts`) and never drifted back
into a second hand-written list: it flags unhedged future-tense promises in shipped UI text, a tool
name claimed by the agent but absent from `EXPECTED_TOOLS`, the same sentence maintained in two files,
a description that no longer matches the code, and any em dash in that copy.

### observability.test.mjs
Executes `src/observability.ts`, the per-turn span helper, and drives `tracedTurn` against a fake
`Tracing`/`Span` pair. Pins that a turn's span carries `blip.session.id` and `blip.operation.id` as
string attributes, that tracing stays off unless the deployment has a key AND the caller asked (the
`X-Blip-Trace: 1` header, which `src/routes.ts` reads and hands to the DO as `submitTurn`'s fourth
argument, since an RPC turn has no request of its own), that the span is opened once and ended once
whether the turn returned or threw, and that a span the runtime dropped costs no attribute writes.
Cannot prove a real Cloudflare trace exists: the platform `tracing` object is faked here. The
route-side half of the gate is pinned by `submit.test.mjs` and `routes.test.mjs` instead, which
record the argument the fake DO actually received.

### paths.test.mjs
Pins the sandbox home to one constant and refuses to let any source still promise a directory the
live sandbox cannot provide; it checks that the three copies agree. Does not touch a real filesystem.

### prefix.test.mjs
Tests `src/directives.ts`: `run:`/`exec:`/`execute:` and `search:` short-circuit the model, the colon
is required, and an empty argument (`"run:  "`) is refused (P2-14). Cannot prove `src/agent.ts` calls
`parseDirective`; that call site is a live path.

### pwa-ui.test.mjs
Static checks on the iPhone-first package: manifest and maskable icons, the iOS meta tags, the shell
service worker (API excluded, offline fallback), the local chat cache and outbox, reconnect flush,
standalone safe areas and the install hint. Also parses both scripts.

### provider.test.mjs
Asserts the AI SDK provider reaches the router service binding at the absolute URL it was configured
with, carrying the bearer the SDK set or the router key when it set none. Does not call a real model.

### queue-search-ui.test.mjs
Static checks on the built console: the queue bar and its per-session storage, the queued-receipt
branch in `send()`, stop clearing the queue, and the cross-session search input and result renderer.
Also parses the one inline script, so a malformed build fails here rather than in a browser.

### registry-input.test.mjs
Executes `src/registry-input.ts`, the DO's query, segment and body parsing. This is the first offline
proof of that parsing, because `src/registry.ts` itself value-imports `agents` and cannot load here.
It runs the pure functions; it does not stand up the DO.

### registry-store.test.mjs
Tests `src/registry-store.ts`, the pure session index, in two layers: `fake-sql.mjs` pins which
statement each export emits and how it binds, then a real `node:sqlite` database runs the same
statements. Covers the `registry_meta` markers and the upsert/`ON CONFLICT` behaviour. No DO.

### registry.test.mjs
Contract tests for the registry DO's rulings a compiler cannot see, plus the R74 `exists` read the
worker's session gates stand on. Some checks read sources as text (notably the `wrangler.jsonc` config
shape, read from this repo only), because Node cannot import `src/registry.ts`; the checks that matter
run against a real sqlite database. It deliberately does not restate `src/types.ts` signatures (tsc
covers those) or DO input parsing and the SQL adapter (now `registry-input.test.mjs` and
`sql-handle.test.mjs`).

### reply.test.mjs
Tests `src/reply.ts`: one harness prompt result projected onto the console's `AgentReply` envelope.
Uses a constructed result, not a live harness call.

### router.test.mjs
Tests the helpers in `src/router.ts`: every LLM call reaches the `ROUTER` service binding at exactly
one `/v1/chat/completions`, with no `X-Tier`, and the caller's `AbortSignal` reaches fetch. Does not
hit an upstream.

### routes.test.mjs
The first offline test to reach the worker's HTTP surface: it imports the real `src/routes.ts` and
drives `handleFetch()` on constructed `Request` objects against a fake `env` (a registry DO stub that
records calls, a federation namespace stub, and a sandbox fetch port). It covers the gate order
(401, then session-id 400 before any addressing, then registry `exists` 404 before any DO), the
`/api/sessions*` family including Task 30's workspace reads and deletes, the read-only
`GET /api/sessions/:id/approval` recovery route, the stream proxy, and two
source scans: R39 (routes.ts value-imports only dependency-free modules and takes both DO namespaces
from `env`) and R42 (`src/index.ts` keeps its non-session handlers). Cannot prove: every agent-side
answer is a stub, so nothing about the real DO is established, and it never opens the deploy tree.

### sandbox-scope.test.mjs
Tests `deploy/sandbox-worker/pool.ts` as real code: the cap counts distinct sessions, an eviction
never takes the session that just asked, recency is read off the lease, and the KV row TTL is no
longer than the VM lease. The worker's wiring that must agree with `pool.ts` is checked as source
text, because the entry module value-imports `e2b` and cannot load offline.

### session-scope.test.mjs
Tests `src/session-scope.ts`: the one copy of the session-id shape (R38), the DO's check that a
session belongs to it, and the single home of `MAIN_DO_NAME`. The last check reads the module's own
source to pin that it imports nothing, which is what keeps it loadable by `src/routes.ts` offline.

### session-search.test.mjs
Tests `src/session-search.ts`: the 2..200 query window, snippet trimming around a match, and the
cross-session merge that attaches registry titles, drops rows for sessions the registry no longer
lists, dedupes the FTS/display overlap, and applies the cap. No DO and no network.

### sql-handle.test.mjs
Tests `src/sql-handle.ts`, the one exec adapter both Durable Objects build `db()` from, against a real
`node:sqlite` prepared statement (the closest offline stand-in for the SDK's `this.sql`): it splits on
`?` and refuses a placeholder/binding mismatch.

### sse-auth.test.mjs
Tests `tokenOk` (Task 22) and `vaultAuthed` (Task 35) in `src/auth.ts`: the GET stream route accepts
`?token=` because EventSource cannot set a header, the vault gate does not, and both fail closed on an
unset or blank secret and compare through `safeEq`.

### stream-hub.test.mjs
Tests `src/stream-hub.ts`: one durable stream per operation, a writer acquired lazily, frames buffered
in order until that writer exists, and a terminal state that survives a simulated eviction.

### skills.test.mjs
Tests SKILL.md parsing (frontmatter, folded descriptions, heading fallback, invalid names), the pure
global skill store on real SQLite, and the authenticated skill routes for save, list, read and
delete. It does not import a Claude Code plugin bundle or run skill scripts.

### submit.test.mjs
Tests Task 23's submit-and-return message route: the response carries both ids and nothing else,
`submitTurn` is the only turn RPC the route calls (it does not wait), and a segment that turns hostile
only when decoded is refused with 400 before any namespace or registry call.

### titles.test.mjs
Tests `src/titles.ts`, the dependency-free title parser and prompt: it cuts at 40 codepoints not
UTF-16 units (an astral fixture written as an escape so the file carries no emoji literal), strips
wrapping quotes, accepts the JSON object form the cheap model often returns, and falls back
deterministically.

### tools.test.mjs
Tests `src/tools.ts`: the wired set is exactly `EXPECTED_TOOLS`, every description is usable by the
model, only read-only tools opt into rerun, and every tool reports live progress bound to its own
`toolCallId`.

### workspace-keys.test.mjs
Tests `src/workspace-keys.ts`: the derived key names, the traversal guard that runs before any key is
built, and the size gate one MiB under the KV entry ceiling. Task 27 added the import-both-and-compare
section that proves the hand-written `deploy/sandbox-worker/workspace.ts` mirror is byte-identical.

### workspace-store.test.mjs
Tests `src/workspace-store.ts`, the snapshot pointer row (Task 29; Task 30 reads it): `fake-sql.mjs`
pins the statements, then a real `node:sqlite` database proves a landed snapshot clears the over-limit
warning, an attempt that did not fit keeps the last good pointer and only adds the warning, a session
that never saved reports null rather than a zero-byte value, and an injection-shaped session id is
stored as data.

### workspace.test.mjs
Tests `deploy/sandbox-worker/workspace.ts` and `auth.ts` through injected fake ports: the mirrored key
names match `src/workspace-keys.ts`, the size gate reads a number `stat` produced inside the sandbox
before bytes leave it, a refused snapshot neither puts nor deletes so the last good copy survives,
`restore` answers the three states the old code conflated (no snapshot, not visible yet, extract
failed) without reporting success, and no base64 travels through a shell argument anymore. Cannot
reach the real `e2b` data plane; the sandbox is an injected port.

## Fixtures and live-only scripts

- `run-all.mjs`: the harness described above.
- `fake-sql.mjs`: an in-memory `SqlHandle` fake the pure-store tests seed through, contract-tested by
  `fake-sql.test.mjs`. No `src/` module imports it; it is a test fixture by design.
- `live-matrix.mjs`: nine probes against a deployed brain over the durable stream. Four are one turn
  (ping, a deterministic `run:` tool turn, the capability answer, freeform generation); five are
  scenarios (session isolation, workspace survival across the four-VM cap's eviction, a model-emitted
  approval hold and resume, two delegated sub-agents, and a ten-call build). It requires `BLIP_URL`
  with no default host and a real key in `.dev.vars`, never prints the key, and cleans up the sessions
  it creates with `{confirm_body:true}`. `BLIP_ONLY=7,8` narrows it to those probe ids while keeping
  the same assertions. Not in the glob.
- `live-stream.mjs`: one model turn, and the four numbers that make "streaming works" measurable:
  first-text latency (budget 12 s from submit), frame count, tool starts versus results, and terminal
  frames (exactly one). Passes only when all four hold. Not in the glob.
- `live-automations.mjs`: creates a real target chat and a webhook automation, posts a delivery,
  waits for the agent's reply, asserts the duplicate delivery and the bad secret, checks the
  automation marker in the transcript, pauses the trigger, verifies a paused delivery is skipped, and
  exercises a valid GitHub HMAC plus a missing signature without spending a second model turn. Cleans
  up both automations and the session. Requires `BLIP_URL` and the local key, prints no secret.
- `live-probe.sh`, `router-probe.mjs`: live-only probes. Not in the glob.
- `capture-ui.mjs`: the visual QA harness. Drives an installed Chrome over CDP at 1440x900,
  834x1112 and 390x844, in both themes, and writes one PNG per console screen. It reads the key from
  `agent_key.local` into the throwaway browser profile only, never prints it, and opens real sessions
  read-only. The chat-with-widgets, populated Tasks, populated Files and connection-error shots are
  synthetic DOM states built by calling the console's own mount functions; they send no request and
  create nothing. `--out` chooses the output folder, `--url` the origin. Not in the glob, and not a
  substitute for a live turn: the send, stream and settle path is tested by an actual `run:` message.

## Coverage gaps worth knowing

- Typecheck split. `npm run typecheck` is `tsc --noEmit` and covers `src` only (root
  `tsconfig.json` has `include: ["src"]`). `npm run typecheck:all` chains that with
  `tsc --noEmit -p deploy/router-worker`, and both pass in a clone with no install beyond the
  root. `npm run typecheck:sandbox` is the separate command for `deploy/sandbox-worker`, and it
  fails here on purpose until you run `npm --prefix deploy/sandbox-worker install`: that project
  declares `e2b` in its own `package.json`, the clone never installs a subproject's dependencies,
  so `src/index.ts` reports TS2307 on that one import while `auth.ts`, `pool.ts` and
  `workspace.ts` typecheck clean. The old `deploy/telegram-bridge` folder was removed on
  2026-10-25; it was never wired into either script or deployed. No script
  typechecks `tests/**`; these `.mjs` files are only ever exercised by running them.
- Held feature, recorded so the hunt is not repeated: an earlier revision of this README called
  `DIRECT_RUN_RE` dead code. It was never dead; the `run:`/`search:` short-circuit it backed is live.
  It is also no longer an identifier anywhere in `src/`: the behavior moved to `src/directives.ts` as
  `parseDirective` (`RUN_RE`/`SEARCH_RE`, colon required). A `grep DIRECT_RUN_RE` that returns nothing
  today is the correct answer, and `tests/prefix.test.mjs` is what pins that path now.
- Nothing offline reaches the real Durable Object storage, the `e2b` data plane, or any network path;
  those are the live matrix. The vault, cron and approval round trips that need a DO are exercised
  only live.
