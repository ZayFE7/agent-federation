# tests/

Thirty entries live here, this README included. Twenty-four are offline, framework-free, and run by
`npm test`:
`approval.test.mjs` (a test that only `exec` is gated by shell risk and a malformed input fails
closed), `context.test.mjs` (a test that every capability claim renders from one table and that
memory sits after the tool guidance), `frames.test.mjs` (a test of the wire vocabulary in
`../src/frames.ts`: the tool-to-widget table, the chunk-to-frame mapping and the one-line SSE
encoding), `guardrails.test.mjs` (a unit test for
`../src/guardrails.ts`), `harness.test.mjs` (a test of `../src/harness-config.ts`, the one harness
options object: the 12-step construction-time budget, the session-bound tool factory, the approval
hook, the explicit recovery numbers and the absence of an invented `onEvent` hook),
`markdown.test.mjs` (a test of
the `md()` renderer shipped in `ui/index.html`), `memory.test.mjs` (a test that compiles
`src/memory.ts` and drives the real recall + task functions against a live `node:sqlite`
database), `paths.test.mjs` (a test that the sandbox home is one constant and that no source
file still promises `/workspace`), `prefix.test.mjs` (a test of `../src/directives.ts`, including
the P2-14 empty-argument hole), `provider.test.mjs` (a test that the AI SDK provider reaches the
router binding at the absolute URL it was configured with), `registry.test.mjs` (a test that
executes the registry
Durable Object's rulings that `tsc` cannot see, the R55 boot seed, the composite index that
serves the sidebar's only query, and since Task 8 the R74 `exists` read the worker's session
gates stand on, against a real `node:sqlite` database),
`registry-input.test.mjs` (a test that executes `src/registry-input.ts`, the DO's query,
segment and body parsing, which `npm test` could never reach through `src/registry.ts`
itself), `registry-store.test.mjs` (a test of `src/registry-store.ts`, the pure session index
and its `registry_meta` markers, against `fake-sql.mjs` and then against a real `node:sqlite`
database), `reply.test.mjs` (a test of `../src/reply.ts`, the harness result projected onto the
console's `AgentReply`), `router.test.mjs` (a test that every router call reaches the `ROUTER`
binding at
exactly one endpoint and hands the caller's AbortSignal to fetch), `routes.test.mjs` (a test
that drives the real `src/routes.ts` against a fake `env`, the first offline test to reach
the worker's HTTP surface), `session-scope.test.mjs` (a test of `src/session-scope.ts`, the
one copy of the session-id shape and of the guard the DO runs on itself, and since the fix
round the single home of `MAIN_DO_NAME`, the name three files used to spell), `sql-handle.test.mjs` (a
test of `src/sql-handle.ts`, the one exec adapter both Durable Objects build their `db()`
from, against a real `node:sqlite` database), `sse-auth.test.mjs` (a test that the EventSource
query token and the Authorization header both fail closed on a blank key and compare through
`safeEq`), `stream-hub.test.mjs` (a test of `../src/stream-hub.ts`: one durable stream per
operation, frames buffered until the writer exists, and a terminal state that survives a simulated
eviction), `submit.test.mjs` (a test that the message route returns the two ids without waiting for
the turn and refuses a hostile id before any DO or registry call), `titles.test.mjs` (a test of `src/titles.ts`, the
title parser that cuts at 40 codepoints rather than UTF-16 units, strips wrapping quotes,
accepts the JSON object form the cheap model often returns, and falls back deterministically),
`tools.test.mjs` (a test of the AI SDK tool set: the four frozen names, recovery policy and
descriptions), and `fake-sql.test.mjs` (a contract test for the
shared fixture). The harness is
`run-all.mjs`. Shared fixtures: `fake-sql.mjs` (an in-memory `SqlHandle` fake for the
pure-store tests, contract-tested by `fake-sql.test.mjs`). Live-only, never run by
`npm test` because they do not end in `.test.mjs`: `live-matrix.mjs`, `live-probe.sh`,
`router-probe.mjs`.

`npm test` is `node tests/run-all.mjs` (`../package.json`). There is still no
vitest/jest/playwright dependency and no CI at all (no `.github/`, no workflow files anywhere
in the project).

`run-all.mjs` globs `tests/*.test.mjs` (it excludes itself), spawns `node <file>` per match
with `stdio: "inherit"`, prints `PASS tests/<file>` or `FAIL tests/<file>` per child, then
prints `<n>/<total> files passed` and exits 1 if any child exited non-zero or if no file
matched at all. Live scripts are outside the glob, so `npm test` makes no network call.

An offline test runs on plain Node with no framework and no build step. Node 24+ strips the
TypeScript types from `../src/guardrails.ts` on import, so `guardrails.test.mjs` needs nothing
else; that module is dependency-free by design so it stays importable this way. It asserts 36
risky commands are flagged and 25 safe ones are not, and exits 0 on pass, 1 on any failure. Run
one file directly with `node tests/guardrails.test.mjs`.

## What it actually checks

`live-matrix.mjs` is a live smoke matrix against the **deployed** brain, driven entirely
through the durable stream. It reads `../.dev.vars` (`:19`), creates one session per probe,
POSTs the turn to that session's submit route with `Authorization: Bearer <AGENT_API_KEY>`,
then reads the returned operation stream as SSE (`readStream`, `:174`) for up to 120 000 ms
(`:16`). The target origin comes from `process.env.BLIP_URL` (`:23`). Exit code 0 only when
all four pass, 1 on any FAIL, 2 on fatal setup errors (`:29,41,52,57`). The four assertions
(`:60-114`):

1. **ping**, `say pong`: the `done` frame's `reply` matches `/pong/i`.
2. **deterministic tool run**, `run: echo blip-can-run`: a `tool-start` names `exec` with
   input containing `echo blip-can-run`, and the same id's `tool-result` output includes
   `blip-can-run`.
3. **capabilities**, `what can you do`: the reply contains `capabilitiesText(EXPECTED_TOOLS)`
   and does not say `planned`. This hits the deterministic capability branch in
   `../src/agent.ts`, which renders from the same table (`:100`).
4. **freeform generation**, `write a 2-line poem about butterflies`: at least 3 non-empty
   `text` frames arrive before `done`.

## Self-contained

The matrix imports `node:fs`, `node:url`, `node:path` and the dependency-free
`../src/capabilities.ts` (`:11-14`). It needs global `fetch` (18+) and nothing from
`node_modules`; importing the capability table is what keeps the probe honest, because the
reply and the assertion are generated from the same source.

## How to run it

It refuses to run against a borrowed deployment. Both setup bugs recorded here earlier are
fixed:

- `BLIP_URL` is required and has **no default host**. Unset (or empty) exits 2 with a message
  naming `set BLIP_URL` (`:20-27`) before any request, so it can no longer print PASS for
  somebody else's worker.
- The key is parsed line by line with `/^AGENT_API_KEY=(.+)$/` (`:41`), so any value shape is
  read, not only hex. A value still equal to the shipped placeholder (`generate-me`,
  `change-me`, `replace-me`, `your-key-here`, `todo`, `xxx`) exits 2 with "Set a real key"
  (`:44-50`) instead of quietly sending a placeholder as a bearer token.

So: `set BLIP_URL=<origin of the worker you deployed>` plus a real `AGENT_API_KEY` in
`.dev.vars` (and the same value as a worker secret), then `node tests/live-matrix.mjs`. The
key itself is never printed; the header line reports only its length.

`live-deep.mjs` and `live-tools2.mjs` are gone (Task 15): both drove `/api/plan` and the old
`{id, approve}` approval body, which no longer exist.

## Probe 2 is deterministic now, but still needs the sandbox

`parseDirective` (`../src/directives.ts`) is wired: `runTurn` in `../src/agent.ts` runs it
before the harness and, on a `run:`/`exec:`/`execute:` prefix, short-circuits straight to
`runSandbox(cmd, session)` without calling the model. So probe 2 no longer depends on the
model choosing the `exec` tool. Those two arms are BLIP-owned early returns before
`harness.session().prompt()`, which means **a directive turn is not in the model's
transcript**: the model never sees a `run:` it answered. That is an accepted Phase 2
limitation, not an oversight; the console still shows the card because each branch writes its
own `logMessage` rows. It does still depend on the `SANDBOX` service binding answering, and
`deploy/sandbox-worker` has no `node_modules` in either local tree, so its `e2b` dependency
(declared at `../deploy/sandbox-worker/package.json:6`) is not installed and the live path is
unexercised. The gap list lives outside this repo (beside the two local trees, not tracked),
so it is not linked from here.

(An earlier revision of this file claimed `DIRECT_RUN_RE` was declared and never referenced,
i.e. dead code. That was wrong; the code wins.)

## Coverage gaps worth knowing

- `npm run typecheck` covers `src` only (`../tsconfig.json:15` is `include: ["src"]`), and
  `deploy/sandbox-worker` and `deploy/telegram-bridge` have no `tsconfig.json` at all, so
  `deploy/**` is never typechecked (except `deploy/router-worker`, which has its own). It also
  never typechecks `tests/**`, so the `.mjs` files here are only ever exercised by running them.
- Nothing tests the vault endpoints, the `/api/decide` or `/api/approve` routes,
  the cron handler, or the DO memory and task schemas (the `sessions`
  schema is covered offline by `registry-store.test.mjs`). The guardrail classifier itself is
  covered offline by `guardrails.test.mjs`; the harness approval round trip needs a Durable
  Object and is only exercised live.
- `npm test` runs twenty-four offline files (`approval`, `context`, `fake-sql`, `frames`,
  `guardrails`, `harness`, `markdown`, `memory`, `paths`, `prefix`, `provider`, `registry`,
  `registry-input`, `registry-store`, `reply`, `router`, `routes`, `session-scope`, `sql-handle`,
  `sse-auth`, `stream-hub`, `submit`, `titles`, `tools`). No offline
  test touches a network: `live-matrix.mjs` needs a deployed worker plus a real key, and it is
  not in the glob.
- `routes.test.mjs` covers the eight worker-side session routes: `GET /api/sessions?limit=N`,
  `POST /api/sessions`, `PATCH /api/sessions/:id`, `DELETE /api/sessions/:id`,
  `GET /api/sessions/:id/messages`, `POST /api/sessions/:id/message`,
  `POST /api/sessions/:id/abort` and
  `GET /api/sessions/:id/stream/:streamId`. Every agent-side answer
  in it is a stub, so it proves nothing about the Durable Object behind those calls, and it
  never opens `project/agent-federation`, so it cannot see deploy-tree drift.
- `fake-sql.mjs` is the fixture the pure-store tests of later tasks build on, and
  `fake-sql.test.mjs` is its contract test: it asserts the `stmts` order, the `results` log,
  the `rows.slice()` copy semantics, first-needle-wins, that only `SELECT` statements are
  answered, and that a reply is exactly `{ results }`. It reports no affected-row count because
  the platform's `SqlStorageCursor` has none (only `rowsRead`/`rowsWritten`) and the `db()`
  adapter in `src/agent.ts` returns `{ results }`, so a fake that shipped the `meta.changes`
  field this one used to have would let a store test pass against an interface production
  cannot supply. No `src/` module imports it (it is a test fixture by design).

## Offline tests, file by file

All run on plain Node, no framework, exit 0 on pass / 1 on any failure.

### `markdown.test.mjs`

`node tests/markdown.test.mjs`

It does **not** re-implement the renderer. It reads `../ui/index.html`, extracts the shipped
`esc()` and `md()` function bodies by source anchors, evals them, and asserts the produced
HTML on 14 cases: fenced code blocks (and that the ```lang fence label is stripped), inline
code, bold, italic, headings, `<ul>`/`<ol>`, safe `[text](https://…)` links, rejection of
`javascript:` links, escaping of `<script>`/`<img>`, no formatting inside code spans, and
multi-paragraph splitting. This is the XSS-safety + correctness gate for chat markdown.

### `memory.test.mjs`

`node tests/memory.test.mjs`

Compiles `../src/memory.ts` to JS with esbuild, imports it, and drives the real exported
functions (`remember`, `recall`, `enqueueTask`, `dueTasks`, one-off lifecycle) against an
in-memory `node:sqlite` `DatabaseSync`. It proves text recall ordering (importance then
recency, empty query returns top memories) and that a served one-off task is deleted while a
daily recurrence is re-armed, not removed. esbuild is located by an existence check over an
ordered candidate list: `BLIP_DEPLOY_NM` when set, this tree's own `node_modules`, then the
sibling `../../project/agent-federation/node_modules`. The first candidate that actually holds
`esbuild/lib/main.js` wins, so the file runs from either tree with no env var; if none does it
prints the list it searched and exits 1.

### `fake-sql.test.mjs`

`node tests/fake-sql.test.mjs`

A contract test for `fake-sql.mjs`, the fixture the pure-store tests seed through
(`registry-store.test.mjs` is its first consumer). 28 checks: `query(needle, rows)` returns the
fake for chaining and `exec()` replies `{ results }` and nothing else; `stmts` records
`[query, bindings]` in call order with bindings never interpolated; `results` logs one reply
per `exec`; the reply array is a `slice()` copy of the seed (the row objects inside it are
still shared, and the test says so); the first registered needle wins. It also pins the
`SELECT` gate: `rowsFor` answers only statements matching `/^\s*select\b/i`, so
`DELETE FROM sessions WHERE id = ?` returns `{ results: [] }` even though its text contains the
seeded `"FROM sessions"` needle, exactly like the real `ctx.storage.sql`.

The fixture used to take a third `query()` argument and answer every `exec()` with a
`meta.changes` count. Both are gone: `SqlStorageCursor` (declared in
`@cloudflare/workers-types`) exposes `next/toArray/one/raw/columnNames/rowsRead/rowsWritten` and
nothing per statement, and the `db()` adapter in `../src/agent.ts` returns `{ results }`, so a
fake that answered `.meta` let a store test pass against an interface production cannot supply
(R37). The checks that used to assert on `changes` now assert the opposite: a reply has exactly
one key.

### `registry-store.test.mjs`

`node tests/registry-store.test.mjs`

Two layers over `../src/registry-store.ts`, the session index Task 6 wraps in a Durable Object
and Task 7 reads through it. The `fake-sql.mjs` layer pins the statement text and the bindings of
all ten exports (schema, upsert, list, get, rename, touch, delete, the `registry_meta` read and
write, and the placeholder title), and sweeps every recorded statement for two promises: one `?`
per binding, which is exactly what the shared exec adapter `../src/sql-handle.ts` enforces before
the SDK sees the query, and no bound string inside its own statement text. The `node:sqlite`
layer runs the same statements against a real database, so the DDL executes twice without error
and keeps the `registry_meta` rows a marker write left behind, `INSERT ... ON CONFLICT(id) DO
UPDATE SET` replaces a known row instead of failing or duplicating it, pinned-then-recent ordering
comes back, `unread` accumulates rather than being assigned, `getSession` answers `null` for a
missing id, and a title of `x'; DROP TABLE sessions; --` round-trips verbatim with the `sessions`
table still present. Silent on success (exit 0), prints every failure and exits 1 otherwise.

### `routes.test.mjs`

`node tests/routes.test.mjs`

The first offline test that reaches the worker's HTTP surface. It imports the real
`../src/routes.ts` and calls `handleFetch()` on constructed `Request` objects against a fake
`env`: a fake registry DO stub that records `list`/`put`/`rename`/`remove`/`touch` in call
order, and a fake `FEDERATION_AGENT` namespace whose stub answers `chat` and `messages` from a
fixture table, answers `fetch` with a recorded `text/event-stream` response, and records the exact
arity each call used. No browser, no dev server and no
Durable Object. The checks cover the seven routes: the `{ ok, sessions, truncated }` list and its
`limit` clamp, the created row, the rename title rule, the delete, the transcript read from the
addressed session, the reply passthrough with `touch(id)` and no opts, and the stream proxy
(query-token auth on the GET stream shape only, the owning DO addressed, `token` and
`authorization` stripped on the internal hop, `from`/`Last-Event-ID` preserved), plus the 401, 400
and
404 paths. Two rules that nothing else can test are pinned in the same file: R39, a source scan
proving `routes.ts` value-imports only dependency-free `src/*.ts` modules and addresses both DOs
through `env` instead of importing a class, and R42, proving `src/index.ts` keeps its own
handlers for `/api/tasks`, `/api/approve`, `/api/decide`, the WebSocket upgrade
and the six `/internal/vault/*` routes while delegating only the `/api/sessions` prefix.

What it cannot prove: every agent-side answer here is a stub, so nothing about the Durable
Object's own behaviour is established, and the file never opens `project/agent-federation`, so
it cannot see deploy-tree drift. It also cannot prove the ordering `src/index.ts` now relies on:
every request it builds has no `Upgrade` header, so a WebSocket upgrade aimed at
`/api/sessions/:id/messages` is answered by the upgrade gate and forwarded to the **main** DO,
not the addressed session. That is deliberate (the delegation sits below the gate on purpose) and
untested. Silent on success (exit 0), prints every failure and exits 1 otherwise.
