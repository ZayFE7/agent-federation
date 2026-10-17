# tests/

`live-matrix.mjs` is the only test in this repo. Nothing else exists: no unit tests, no
fixture directory, no `npm test` script (`../package.json` defines only `dev`, `deploy`,
`typecheck`), no vitest/jest/playwright in the dependencies, and no CI at all (no `.github/`,
no workflow files anywhere in the project).

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
  `ui/index.html:357` and `:358` hardcode the same host.

Minimal fix: set a fresh hex-only `AGENT_API_KEY` in `.dev.vars` (`[a-f0-9]+` matches it) and
push the same value to the brain as a secret, then point `:12` at the worker you actually
deployed, ideally via `process.env.BLIP_URL` with a fallback rather than one literal.

## Expect probe 2 to fail for the wrong reason

Its label says "deterministic", but `DIRECT_RUN_RE` (`../src/agent.ts:65`) is declared and
never referenced anywhere in `src/`: the deterministic `run:` short-circuit the comment
promises is dead code. So probe 2 depends on the model choosing the `exec` tool and on the
`SANDBOX` service binding answering, which is untestable while `e2b` is not installed
(`../deploy/sandbox-worker/package.json:6`). See `../../../GAPS.md`.

## Coverage gaps worth knowing

- `npm run typecheck` covers `src` only (`../tsconfig.json:14` is `include: ["src"]`), and
  `deploy/sandbox-worker` and `deploy/telegram-bridge` have no `tsconfig.json` at all, so
  `deploy/**` is never typechecked (except `deploy/router-worker`, which has its own).
- Nothing tests the vault endpoints, the `/api/decide` route, the cron handler, or the DO
  memory and task schemas.
- There is no offline or mock-mode test; every assertion needs a live router with real
  provider keys.
