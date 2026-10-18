# tests/

Nine files live here. Offline, framework-free, run by `npm test`:
`guardrails.test.mjs` (a unit test for `../src/guardrails.ts`), `markdown.test.mjs` (a test of
the `md()` renderer shipped in `ui/index.html`), and `memory.test.mjs` (a test that compiles
`src/memory.ts` and drives the real recall + task functions against a live `node:sqlite`
database). The harness is `run-all.mjs`. Shared fixtures: `fake-sql.mjs` (an in-memory
`SqlHandle` fake for the pure-store tests, not yet used by any test). Live-only, never run by
`npm test` because they do not end in `.test.mjs`: `live-matrix.mjs`, `live-deep.mjs`,
`live-tools2.mjs`, `live-probe.sh`.

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

`live-matrix.mjs` is a live smoke matrix against the **deployed** brain. It reads
`../.dev.vars` (`:16`), POSTs 4 probes to `URL_ENDPOINT` with `Authorization: Bearer
<AGENT_API_KEY>`, waits up to 120 000 ms each (`:13`), and prints status, reply preview, tool
count, state, PASS/FAIL per probe. The target origin comes from `process.env.BLIP_URL` (`:20`)
and `/api/message` is appended to it (`:28`). Exit code 0 only when all four pass, 1 on any
FAIL, 2 on fatal setup errors (`:26,38,49,54`). The four assertions (`:57-99`):

1. **ping**, body `{content:"say pong"}`: HTTP 200 and `/pong/i` matches `reply` (`:61-66`).
2. **deterministic tool run**, `{content:"run: echo blip-can-run"}`: `tools[0].cmd` includes
   `echo blip-can-run` **and** `tools[0].output` includes `blip-can-run` (`:71-78`).
3. **capabilities**, `{content:"what can you do"}`: `reply` lowercased contains `sandbox`
   (`:83-88`). This one hits the deterministic capability branch at `../src/agent.ts:576-590`.
4. **freeform generation**, `{content:"write a 2-line poem about butterflies"}`: `reply`
   non-empty and does not contain `[error]` (`:92-98`).

## Self-contained

Only `node:fs`, `node:url`, `node:path` are imported (`:9-11`). No dependencies, so it runs
on any Node with global `fetch` (18+), with or without `node_modules`.

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

`live-deep.mjs` (`:9`, `:12`) and `live-tools2.mjs` (`:6-8`) still carry the old hardcoded host
and the old hex-only key regex; they are outside this file's fix and outside `npm test`.

## Probe 2 is deterministic now, but still needs the sandbox

`DIRECT_RUN_RE` (`../src/agent.ts:82`) is wired: `handleChat` runs it at `../src/agent.ts:548`
and, on a `run:`/`exec:`/`execute:` prefix, short-circuits straight to `execSandbox(cmd)`
(`../src/agent.ts:551`) without calling the model. So probe 2 no longer depends on the model
choosing the `exec` tool. It does still depend on the `SANDBOX` service binding answering, and
`deploy/sandbox-worker` has no `node_modules` in either local tree, so its `e2b` dependency
(declared at `../deploy/sandbox-worker/package.json:6`) is not installed and the live path is
unexercised. The gap list lives outside this repo (beside the two local trees, not tracked),
so it is not linked from here.

(An earlier revision of this file claimed `DIRECT_RUN_RE` was declared and never referenced,
i.e. dead code. That was wrong; the code wins.)

## Coverage gaps worth knowing

- `npm run typecheck` covers `src` only (`../tsconfig.json:14` is `include: ["src"]`), and
  `deploy/sandbox-worker` and `deploy/telegram-bridge` have no `tsconfig.json` at all, so
  `deploy/**` is never typechecked (except `deploy/router-worker`, which has its own). It also
  never typechecks `tests/**`, so the `.mjs` files here are only ever exercised by running them.
- Nothing tests the vault endpoints, the `/api/decide`, `/api/plan`, or `/api/approve` routes,
  the cron handler, or the DO memory, task, plan, and pending-action schemas. The guardrail
  classifier itself is covered offline by `guardrails.test.mjs`; the approve/hold flow around
  it is not.
- `npm test` runs three offline files (`guardrails`, `markdown`, `memory`). No offline test
  touches a network: `live-matrix.mjs` needs a deployed worker plus a real key, and it is not
  in the glob.
- `fake-sql.mjs` is a fixture with no consumer yet; it exists for the pure-store tests that
  later tasks add. Nothing imports it today.

## Offline UI + memory tests (added)

Both run on plain Node, no framework, exit 0 on pass / 1 on any failure.

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
daily recurrence is re-armed, not removed. esbuild is found via `BLIP_DEPLOY_NM` or the
sibling `../project/agent-federation/node_modules` layout; set `BLIP_DEPLOY_NM` if your trees
are not adjacent.
