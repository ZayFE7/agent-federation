# tests/

Two tests live here: `live-matrix.mjs` (a live smoke matrix against the deployed brain) and
`guardrails.test.mjs` (an offline unit test for `../src/guardrails.ts`). There is still no
fixture directory, no `npm test` script (`../package.json` defines only `dev`, `deploy`,
`typecheck`), no vitest/jest/playwright in the dependencies, and no CI at all (no `.github/`,
no workflow files anywhere in the project).

`guardrails.test.mjs` runs on plain Node with no framework. Node 24+ strips the TypeScript
types from `../src/guardrails.ts` on import, so it needs no build step; that module is
dependency-free by design so it stays importable this way. It asserts 36 risky commands are
flagged and 25 safe ones are not, and exits 0 on pass, 1 on any failure. Run it with
`node tests/guardrails.test.mjs`.

## What it actually checks

A live smoke matrix against the **deployed** brain. It reads `../.dev.vars` (`:16`), POSTs
4 probes to `URL_ENDPOINT` with `Authorization: Bearer <AGENT_API_KEY>`, waits up to
120 000 ms each (`:13`), and prints status, reply preview, tool count, state, PASS/FAIL per
probe. Exit code 0 only when all four pass, 1 on any FAIL, 2 on fatal setup errors
(`:24,29,141`). The four assertions (`:34-76`):

1. **ping**, body `{content:"say pong"}`: HTTP 200 and `/pong/i` matches `reply` (`:39-42`).
2. **deterministic tool run**, `{content:"run: echo blip-can-run"}`: `tools[0].cmd` includes
   `echo blip-can-run` **and** `tools[0].output` includes `blip-can-run` (`:49-54`).
3. **capabilities**, `{content:"what can you do"}`: `reply` lowercased contains `sandbox`
   (`:61-63`). This one hits the hardcoded deterministic branch at `../src/agent.ts:297-308`.
4. **freeform generation**, `{content:"write a 2-line poem about butterflies"}`: `reply`
   non-empty and does not contain `[error]` (`:71-73`).

## Self-contained

Only `node:fs`, `node:url`, `node:path` are imported (`:8-10`). No dependencies, so it runs
on any Node with global `fetch` (18+), with or without `node_modules`.

## It cannot run as pulled

Two hard blockers:

- `:26` parses the key with `/AGENT_API_KEY=([a-f0-9]+)/`. `.dev.vars` ships
  `AGENT_API_KEY=generate-me`, which has no hex-only value, so `readApiKey()` prints FATAL
  and exits 2 before the first request (`:27-30`).
- `:12` hardcodes `https://agent-federation.agent-federation.workers.dev/api/message`, the
  old account's URL, so even with a key it tests whatever is deployed there, not your build.
  The console (`ui/index.html`) now keeps that host in a single `const AGENT` near the top of
  its script block and every fetch (`fedChat`, `loadTasks`, `loadPlan`, `decide`) reads from
  it, so the UI has one place to repoint; `live-matrix.mjs` still has its own literal at `:12`.

Minimal fix: set a fresh hex-only `AGENT_API_KEY` in `.dev.vars` (`[a-f0-9]+` matches it) and
push the same value to the brain as a secret, then point `:12` at the worker you actually
deployed, ideally via `process.env.BLIP_URL` with a fallback rather than one literal.

## Probe 2 is deterministic now, but still needs the sandbox

`DIRECT_RUN_RE` (`../src/agent.ts:80`) is wired: `handleChat` runs it at `../src/agent.ts:530`
and, on a `run:`/`exec:`/`execute:` prefix, short-circuits straight to `execSandbox(cmd)`
without calling the model. So probe 2 no longer depends on the model choosing the `exec`
tool. It does still depend on the `SANDBOX` service binding answering, which is untestable
while `e2b` is not installed (`../deploy/sandbox-worker/package.json:6`). See `../../../GAPS.md`.

(An earlier revision of this file claimed `DIRECT_RUN_RE` was declared and never referenced,
i.e. dead code. That was wrong; the code wins.)

## Coverage gaps worth knowing

- `npm run typecheck` covers `src` only (`../tsconfig.json:14` is `include: ["src"]`), and
  `deploy/sandbox-worker` and `deploy/telegram-bridge` have no `tsconfig.json` at all, so
  `deploy/**` is never typechecked (except `deploy/router-worker`, which has its own).
- Nothing tests the vault endpoints, the `/api/decide`, `/api/plan`, or `/api/approve` routes,
  the cron handler, or the DO memory, task, plan, and pending-action schemas. The guardrail
  classifier itself is covered offline by `guardrails.test.mjs`; the approve/hold flow around
  it is not.
- `guardrails.test.mjs` is the only offline test. `live-matrix.mjs` still needs a live router
  with real provider keys for every assertion.
