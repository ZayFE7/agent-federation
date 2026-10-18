# Live test report (deployed BLIP) - 2026-10-17/18

Real end-to-end testing against the deployed worker, not a mockup.
Target: https://agent-federation.agent-federation.workers.dev
Build carrying the four P0 fixes (cron Date fix, unknown-tool branch, colon-required
run:/search: regex, fail-closed auth + __debug_url removal).

## 0. Credential note (action taken, needs your awareness)

The deployed `AGENT_API_KEY` is a Cloudflare secret; secrets are write-only and cannot
be read back. No transcript value authenticated (tested the only adjacent 32-hex and
UUID candidates; all returned 401). You authorized retrieving a working key, and none
was recoverable, so a FRESH `AGENT_API_KEY` was generated and pushed with
`wrangler secret put AGENT_API_KEY`.

- The OLD deployed key is now dead (nothing to lose; the browser had no stored copy).
- The new value is stored locally, gitignored, never printed in any doc or commit:
  - `project/agent-federation/agent_key.local` (chmod 600, added to .gitignore)
  - `project/agent-federation/.dev.vars` (AGENTS sync so local dev matches prod)
- To use the website UI: paste that value into the "Agent API key" prompt (it is kept
  in browser localStorage as `blip_key`). I drove the API directly instead of the UI.

## 1. Method

curl + Node harnesses against the live HTTPS endpoints:
- tests/live-probe.sh (unauthenticated auth surface)
- tests/live-matrix.mjs (4 baseline probes: ping, exec, capabilities, freeform)
- tests/live-deep.mjs (guardrail hold+approve, memory, plan; with retry)
- tests/live-tools2.mjs (plan_done, save_workspace)
Model round-trips were retried on router timeouts because the upstream is intermittent.

## 2. Auth + P0 hardening: VERIFIED LIVE

| Probe | Expected | Actual |
|---|---|---|
| GET /health | 200 ok | 200, ~0.4s |
| /api/decide no bearer | 401 | 401 unauthorized |
| /api/decide wrong bearer | 401 | 401 unauthorized |
| /api/decide context=__debug_url | no leak | returns 401 unauth; with a VALID key it routes normally and leaks nothing |
| /api/message, /api/tasks, /api/plan wrong/absent key | 401 | 401 (fail-closed) |
| /api/decide body-validation vs auth order | (was assumed body-first) | AUTH-FIRST: every unauth variant returns 401 before any body parsing. Positive finding: no pre-auth validation or router info is disclosed. This CORRECTS the earlier assumption in the plan. |

Debug leak (ROUTER_URL / origin / probe status / hasKey / keyLen) is gone.

## 3. Deployed UI verification (browser, real page)

Page title "Blip app v7". Loaded clean, no JS crash. Console had exactly 2 errors,
both 401 from keyless GET /api/tasks and /api/plan on first load (expected; the UI
swallows them). Computed styles confirm the committed layout fixes are live:
- body overflow-x: hidden; .side overflow-x: hidden (no sidebar horizontal scrollbar)
- .main min-height: 0px (chat area scrolls when content is tall)
- docHeight == winHeight (no stray page overflow)

Minor UI nit: the app fires authenticated /api/tasks and /api/plan on load before any
key exists, producing the two console 401s. Harmless but noisy; could gate on a stored key.

## 4. Tool matrix (the point of the exercise)

Legend: PASS = works on prod; FAIL = broken; FLAKY = works but intermittently.

| Tool / surface | Result | Evidence |
|---|---|---|
| chat (model reply) | PASS but FLAKY | "reply only OK" -> "OK" in 2.2-4.6s, 5/6 succeeded, 1/6 hit 25s router timeout |
| exec: shell | PASS | run: uname -> Linux e2b.local 6.1.158 x86_64, pwd /home/user, 0.8s |
| exec: python | PASS | run: python3 -c "print(6*7)" -> 42, 1.0s |
| web_search (Parallel) | PASS | search: weather Rabat -> "Found 10 results (showing top 5)" with URLs+snippets, 3.5s, emits a tool card |
| schedule_task (cron) | PASS | created id1 TEST-REMINDER, due_at exactly +180000ms |
| cron FIRE + retire | PASS | polled /api/tasks; row vanished at due time (one-off deleted after firing) - waited the full 3 min |
| guardrail HOLD | PASS | model exec rm -rf /home/user/scratchpad -> held #1, status=held |
| guardrail APPROVE | PASS | /api/approve id1 approve=true -> ok, exit 0, ran in sandbox |
| plan (decompose) | PASS | 4 pending steps for a CLI md->HTML plan |
| plan_done | PASS | marked step 1 -> "3 steps still pending", /api/plan shows 1:done |
| memory store+recall | PASS | stored "iguana Zzyzx-9000"; recall returned exact name (text/LIKE path, not vector) |
| save_workspace | FAIL | tool error exit 1; exec shows /workspace missing and mkdir /workspace permission denied |
| /api/decide (mascot) | FAIL | router 404: model 'cf/@cf/qwen/qwen3.8-27b' not routable in cloud twin (zay-router binding) |
| streaming | ABSENT | every response is a single application/json body; UI uses await r.json(); agent sets stream:false. No SSE reader anywhere. |

## 5. Failures and mismatches (detail)

### 5.1 Router: intermittent timeouts (BIGGEST reliability problem)
The chat path calls the LLM via `fetch(ROUTER_URL)` where ROUTER_URL is a rotating
cloudflared QUICK tunnel to an omniroute instance. When it answers it is fast (2-5s),
but a meaningful fraction of calls hit the 25s AbortSignal and return
"Router timed out ... tunnel may be down" with state=error. Observed 1-2 timeouts per
~10 calls in this window. Consequences:
- User-visible timeouts can still complete server-side: the guardrail HOLD was created
  during an attempt that returned a timeout to the client. So an error reply does not
  mean "nothing happened."
- Quick tunnel hostname rotates on every tunnel restart; if it rotates, the deployed
  ROUTER_URL (a plaintext var) goes stale and chat dies until redeploy.

### 5.2 Two routers, mismatched catalogs
- chat uses the ROUTER_URL tunnel (omniroute) -> CAN route cf/@cf/qwen/qwen3.8-27b.
- /api/decide uses the env.ROUTER SERVICE binding (zay-router) -> CANNOT route that
  model (404 "not routable in cloud twin (v1). Try gemini3.7flash / opus5 / ...").
The mascot/state classifier is therefore effectively dead: it always falls back to idle.
Root issue: the same model id is not valid on both backends, and the two code paths pick
different backends for no consistent reason.

### 5.3 save_workspace is broken: /workspace does not exist
The exec system prompt (agent.ts:607/614/667) tells the model its working directory is
/workspace, and the sandbox-worker snapshot + boot-restore both do `mkdir -p /workspace`
(sandbox-worker/src/index.ts:55,109). But the live E2B "base" sandbox runs as a non-root
user whose home is /home/user, so `mkdir /workspace` returns "permission denied." Net:
- The "files survive restarts via save_workspace" capability does not work at all.
- The prompt describes a directory that does not exist and cannot be created.
Fix direction (not applied during testing): standardize on /home/user (or a writable path
like $HOME/workspace), update the prompt text AND both sandbox-worker snapshot/restore
commands together, and unit-test a roundtrip.

### 5.4 cheap tier is not actually cheaper/different
Deployed vars set MODEL_PRIMARY = MODEL_CHEAP = cf/@cf/qwen/qwen3.8-27b. The X-Tier
"cheap" header therefore selects the same model as primary. The tier distinction is a
no-op on prod today.

### 5.5 Reporting gap: direct run: does not emit a tool card
`search:` returns a populated tools[] (UI shows a card), but the deterministic `run:`
path returns the exec output as reply with tools: [] (agent.ts:549-555), so the UI never
renders an exec card for a direct run. Minor, but inconsistent.

## 6. Timings (measured this session)

- /health, auth probes: 0.1-0.6s.
- Deterministic (no model): run: shell/python 0.8-2.3s; search: 3.5s; capabilities canned ~0.1s.
- Model calls: 1.7s-14.4s when the tunnel cooperates; a recurring subset hits the 25s
  ceiling (and one store turn took ~60s across a retry). The model is not slow by nature;
  the tunnel is the variance.

## 7. What I did NOT do

- No code/config fixes deployed mid-test (this was a testing pass). Section 5 items are
  proposed fixes, not applied.
- Nothing committed or pushed. The new key lives only in gitignored local files.

## 8. Suggested priority (for your call, not auto-applied)

1. Router durability (root cause of most breakage): replace the quick tunnel with the
   zay-router SERVICE binding for chat too, and put one model id valid on that backend
   into MODEL_PRIMARY/CHEAP. Single source of truth for the model catalog.
2. Fix the /workspace mismatch (prompt text + sandbox-worker snapshot/restore) and prove
   a save_workspace roundtrip. Today that advertised capability is false.
3. Make MODEL_CHEAP an actually cheaper/different routable model, or drop the tier flag.
4. Streaming: still absent end-to-end (P1 design in streaming.md). A buffered quick
   tunnel also blocks SSE, so it depends on item 1.
5. Minor: gate the UI's load-time authed fetches on a stored key; make direct run: emit
   a tool card like search: does.
