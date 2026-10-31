# Event Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Let BLIP create automations that fire from signed webhooks, watched URLs, and schedules, then run a durable turn in a target chat with dedupe, conditions, rate limits, and run history.

**Architecture:** A new singleton `AutomationAgent` Durable Object owns automations, events, runs, watcher state, secrets, and its own alarm. Public `/hooks` routes validate a per-automation secret or GitHub HMAC. Accepted events become turns in an existing session through `submitTurn` with an automation origin. The session reports completion back to the AutomationAgent.

**Tech stack:** Cloudflare Workers, Durable Objects with SQLite, existing Agents SDK, WebCrypto, existing model-secret AES-GCM helper, plain Node 24 tests with `node:sqlite`.

**Spec:** `repo-clone/docs/superpowers/specs/2026-10-26-event-triggers-design.md`

## Global constraints

- Edit `repo-clone` first. Mirror to `project/agent-federation` only for deploy. Never copy or content-diff the deploy tree's `wrangler.jsonc`.
- No push unless asked. Commit only files named by the task.
- Native main writer plus explicitly scoped subagents. One writer per file. Read-only review is allowed.
- No new paid dependency and no card.
- No secret, tunnel host, relay prefix, account id, or `.dev.vars` value in code, tests, logs, or tracked docs.
- Automation secrets are encrypted at rest with the existing `encryptSecret` helper. GET routes return a hint only.
- Public ingress only for declared automations with a valid secret or GitHub HMAC.
- Event-origin turns must never execute deterministic `run:` directives.
- Body cap 128 KB, stored payload 32 KB, conditions 8 KB, instructions 8 KB.
- Defaults: cooldown 10 s, 20 fires per rolling hour, 2 running turns, 50 queued events, 200 runs per day, watcher interval floor 5 minutes, auto-pause after 10 watch errors.
- No email ingress in this milestone.
- Both trees must pass `npx tsc --noEmit` and `npm test`, and the UI script must pass `node --check`.

## Review Focus

- A duplicate provider delivery must not run twice. Tested in Task 3 (`ingest duplicate`) and Task 6 (`route duplicate`).
- A malformed or missing signature must not reach a turn. Tested in Task 4 (`bad HMAC`, `missing secret`).
- An event prompt containing `run: rm -rf` must not bypass approval. Tested in Task 5 (`automation origin skips directives`).
- A target session that does not exist must not instantiate an orphan DO. Tested in Task 6 (`target missing`).
- A watcher that returns the same content every check must not spend model tokens. Tested in Task 4 (`unchanged no event`).

---

## File structure

New pure modules:

- `src/automation-types.ts`: ids, kinds, row shapes, source configs, conditions, caps, defaults.
- `src/automation-store.ts`: `AutomationStore` over `SqlHandle`.
- `src/automation-match.ts`: data-only condition matcher.
- `src/automation-security.ts`: secret generation, encryption, safe compare, GitHub HMAC, body caps, safe URL guard.
- `src/automation-schedule.ts`: interval/daily next-time calculations, watcher fingerprint, response normalization.
- `src/automation-engine.ts`: ingest, dedupe, conditions, rate limits, queueing, run transitions, due-tick planning, completion. Injected store/session/clock/fetch.
- `src/automation-agent.ts`: `AutomationAgent` DO wrapper, alarm, schema, real engine dependencies.
- `src/automation-routes.ts`: `/api/automations` and `/hooks`.
- `src/automation-tools.ts`: `automation_create`, `automation_status`, `automation_control`.

Modified:

- `src/types.ts`: `AUTOMATION` binding, `TurnOrigin`, `AutomationAgentStub`, `AgentStub` additions.
- `src/index.ts`: export `AutomationAgent`, route `/hooks` before assets and `/api/automations`.
- `src/agent.ts`: origin-aware `submitTurn`, directive skip, completion callback, `turnStatus`.
- `src/tools.ts`, `src/capabilities.ts`: three automation tools, `EXPECTED_TOOLS` becomes 11.
- `src/routes.ts`: export `newSessionId` if the automation route creates nothing; it should not create sessions.
- `.scratch/ui-rebuild/app.js`, `app.css`, `shell.html`, `ui/index.html`.

Tests:

- `tests/automation-store.test.mjs`
- `tests/automation-match.test.mjs`
- `tests/automation-security.test.mjs`
- `tests/automation-schedule.test.mjs`
- `tests/automation-engine.test.mjs`
- `tests/automation-routes.test.mjs`
- `tests/automation-tools.test.mjs`
- `tests/automation-agent.test.mjs` (source checks / pure hooks)
- updates to `tests/tools.test.mjs`, `tests/routes.test.mjs`, `tests/no-drift.test.mjs`, `tests/README.md`
- `tests/live-automations.mjs`

---

### Task 1: Types, caps, and the automation store

**Files:** create `src/automation-types.ts`, `src/automation-store.ts`, test `tests/automation-store.test.mjs`.

**Interfaces:**
- `AutomationRow`, `AutomationEventRow`, `AutomationRunRow`, `WatchStateRow`, `AutomationSource`, `MatchNode`, `AutomationKind`, `CreateAutomationInput`, `AutomationStatus`.
- `class AutomationStore` with `ensureSchema()`, `create(input, now, id)`, `get(id)`, `list(filter, limit)`, `update(id, patch)`, `setEnabled(id, enabled)`, `rotateSecret(id, enc, hint, now)`, `insertEvent(row)`, `getEventByKey(automationId, key)`, `updateEvent(id, patch)`, `listEvents(automationId, after, limit)`, `insertRun(row)`, `getRun(id)`, `updateRun(id, patch)`, `listRuns(automationId, limit)`, `watchState(id)`, `upsertWatchState(row)`, `rateCount(id, windowStart)`, `bumpRate(id, windowStart)`, `prune(now)`, `meta(key)`, `setMeta(key, value)`.
- Constants: `AUTOMATION_LIMITS`, `DEFAULT_COOLDOWN_MS`, `MAX_BODY_BYTES`, `MAX_PAYLOAD_BYTES`, `EVENT_RETENTION_MS`.

- [ ] **Step 1: Write failing store tests**

Use `node:sqlite`. Assert schema creation; create/list/get/update; unique `(automation_id, event_key)` rejects a duplicate; `insertEvent` returns null or throws classified duplicate; rate window increment; watch state upsert; prune removes old events/runs but keeps automations; terminal statuses; secrets never in list projections.

- [ ] **Step 2: Run and see it fail**

`node tests/automation-store.test.mjs` -> FAIL missing module.

- [ ] **Step 3: Implement types and store**

All statements parameterized. JSON caps enforced by a `capJson` helper before insert. Use `INSERT ... ON CONFLICT DO NOTHING` for event dedupe and return a boolean via a read-back because SQLite `changes` is not exposed through `SqlHandle`.

- [ ] **Step 4: Green + typecheck + full suite**

`node tests/automation-store.test.mjs && npx tsc --noEmit && node tests/run-all.mjs`.

- [ ] **Step 5: Commit this task only**

`git add src/automation-types.ts src/automation-store.ts tests/automation-store.test.mjs` and commit `feat: add automation store`.

---

### Task 2: Condition matcher

**Files:** create `src/automation-match.ts`, test `tests/automation-match.test.mjs`.

**Interfaces:** `evaluateMatch(match: MatchNode | null, data: unknown): { ok: boolean; reason: string }`; `parseMatch(json: string | null): MatchNode | null`.

- [ ] **Step 1: Write failing tests**

Assert:
- `all` and nested `any`.
- `eq`, `neq`, `contains`, `startsWith`, `endsWith`, `exists`, `gt`, `lt`, `in`.
- Dotted paths and numeric array indices.
- Missing path behavior.
- Max 32 nodes and max depth 3.
- Rejects unknown operators and non-data nodes.
- No regex or function-like strings execute.

- [ ] **Step 2: Run fail, implement, run green**

`node tests/automation-match.test.mjs` then implement and rerun. Typecheck.

- [ ] **Step 3: Commit**

`git add src/automation-match.ts tests/automation-match.test.mjs` and commit.

---

### Task 3: Security, secret handling, and schedule/watcher calculations

**Files:** create `src/automation-security.ts`, `src/automation-schedule.ts`, tests `tests/automation-security.test.mjs`, `tests/automation-schedule.test.mjs`.

**Interfaces:**
- `generateSecret(): string`, `secretHint(secret): string`, `verifySecret(provided, expected): boolean`.
- `verifyGithubSignature(rawBody: Uint8Array, header: string | null, secret: string): Promise<boolean>`.
- `safeIngressBody(text: string): { ok; bytes; error? }`.
- `safeFetchUrl(raw: string): string | null`.
- `nextIntervalDue(everyMinutes, from, now): number`, `nextDailyDue(hhmm, from, now): number`, `watcherFingerprint(body, contentType): Promise<string>`, `watcherPayload(...)`.

- [ ] **Step 1: Write failing tests**

Cover: 32-byte base64url secret, hint is last four; HMAC valid/invalid/missing and SHA1 rejected; body 128 KB accept, over cap reject; URL guard rejects `file:`, `javascript:`, credentials, localhost, private IP literals; interval floor; daily UTC strictly in the future; stable JSON fingerprint ignores key order; changed text fingerprint differs.

- [ ] **Step 2: Run fail, implement, green**

`node tests/automation-security.test.mjs && node tests/automation-schedule.test.mjs`; implement; rerun. Typecheck.

- [ ] **Step 3: Commit**

`git add src/automation-security.ts src/automation-schedule.ts tests/automation-security.test.mjs tests/automation-schedule.test.mjs`.

---

### Task 4: Automation engine

**Files:** create `src/automation-engine.ts`, test `tests/automation-engine.test.mjs`.

**Interfaces:**
- `interface AutomationEngineDeps { store; session: SessionPort; fetch: typeof fetch; now(): number; id(): string; encrypt(secret: string): Promise<string>; decrypt(enc: string): Promise<string>; }`
- `SessionPort`: `exists(sessionId)`, `submit(input: SubmitAutomationInput): Promise<{ ok; streamId?; operationId?; error? }>`, `status(streamId): Promise<{ status; reply?; error? }>`.
- `class AutomationEngine` with `create(input)`, `ingestHttp(input)`, `tick(now)`, `completeRun(input)`, `control(id, action, note?)`, `preview(id)`.

**Core methods:**
- `create` validates target, caps, kind config, secret generation/encryption, next run for watchers/schedules.
- `ingestHttp` auth is done by the route before; engine handles dedupe, condition, cooldown/rate, event insert, and submission.
- `tick` finds due watches/schedules, fetches due watchers with `safeFetchUrl`, creates events only on change, queues/submits due runs, reconciles stale runs, prunes.
- `completeRun` idempotent.

- [ ] **Step 1: Write failing engine tests with a fake session and clock**

Assert:
- create validates missing target.
- duplicate event key creates no second run.
- condition false stores `skipped`.
- cooldown/rate stores `rate_limited`.
- one active run per session; second event queued.
- submit failure retries three times with 1/5/15m and then fails.
- completed turn error is failed and never auto-retried.
- watcher first check seeds; unchanged no event; changed event.
- watcher 10 errors auto-pauses.
- schedule fires due, next due is computed from now not completion.
- completeRun duplicate ignored; stale run reconciled via `status`.
- manual retry creates a new run.

- [ ] **Step 2: Run fail, implement, green**

`node tests/automation-engine.test.mjs`. Use the real `AutomationStore` with `node:sqlite`. Keep fetch and session fake. Typecheck.

- [ ] **Step 3: Commit**

`git add src/automation-engine.ts tests/automation-engine.test.mjs`.

---

### Task 5: Session origin and completion callback

**Files:** modify `src/agent.ts`, `src/types.ts`, create `src/automation-origin.ts` if a pure helper is useful, add `tests/automation-agent.test.mjs` source checks and pure tests.

**Interfaces:**
- `TurnOrigin` in `types.ts`.
- `submitTurn(..., origin?: TurnOrigin)`.
- `turnStatus(streamId): Promise<{ status: "running"|"done"|"error"|"unknown"; reply?: string; error?: string }>`.
- On finalize, if origin.kind is automation, call `env.AUTOMATION.get(idFromName("automation")).completeRun(...)` with a run id.
- `streamDirect` is skipped for automation origin.

- [ ] **Step 1: Write failing source and behavior checks**

Assert `submitTurn` accepts origin; `human` preserves directives; `automation` does not call `streamDirect` even for a `run:` prompt; finalize sends the callback once; `turnStatus` reads terminal state and the last assistant text; the automation route does not pass a human origin.

- [ ] **Step 2: Run fail, implement, green**

`node tests/automation-agent.test.mjs && node tests/submit.test.mjs`. Typecheck.

- [ ] **Step 3: Commit**

---

### Task 6: DO, routes, tools, and wiring

**Files:** create `src/automation-agent.ts`, `src/automation-routes.ts`, `src/automation-tools.ts`, modify `src/types.ts`, `src/index.ts`, `src/tools.ts`, `src/capabilities.ts`, tests.

**Interfaces:**
- `AutomationAgent extends Agent<Env>`: `alarm()`, RPC methods matching the engine, `ingestHook(input)`.
- Public `POST /hooks/:id/:secret` and `/hooks/:id`; auth, cap, GitHub HMAC; returns status codes from the design.
- Auth routes for CRUD/control/events/runs/attention.
- Tools `automation_create`, `automation_status`, `automation_control`. `EXPECTED_TOOLS` 11.
- `Env.AUTOMATION` and `export { AutomationAgent }`.

- [ ] **Step 1: Write failing route/tool tests**

Cover auth, 401 wrong secret, 404 unknown, 413 body, 429 rate, 200 duplicate, route ordering `/api/automations/attention` before `/:id`, target missing 404, create returns URL/secret once, list never returns secret, tool actions cannot delete, `EXPECTED_TOOLS` 11.

- [ ] **Step 2: Run fail, implement, green**

`node tests/automation-routes.test.mjs && node tests/automation-tools.test.mjs && npx tsc --noEmit && node tests/run-all.mjs`.

- [ ] **Step 3: Commit**

---

### Task 7: Automations UI

**Files:** modify `.scratch/ui-rebuild/app.js`, `app.css`, `shell.html`, build `ui/index.html`, test `tests/automation-ui.test.mjs` or extend `tests/ui.test.mjs`.

- [ ] **Step 1: Write failing UI checks**

Assert nav has Automations, list sections, create form fields, webhook URL/secret-once, rotate, pause/resume/delete, events/runs timelines, Activity card, mobile layout strings, no dead buttons.

- [ ] **Step 2: Implement data loaders and pages**

`loadAutomations`, `loadAutomation`, `loadAutomationEvents`, `loadAutomationRuns`, 3s poll only while the page is visible, signature-based re-render. Keep old Scheduled tasks in a section. Add event/runs preview.

- [ ] **Step 3: Build and verify**

`node .scratch/ui-rebuild/build.mjs && node tests/automation-ui.test.mjs && node tests/run-all.mjs`. Browser QA with a fake/live automation.

- [ ] **Step 4: Commit**

---

### Task 8: Live verification, deploy, records

- [ ] **Step 1: Deploy binding** in both trees via manual edits; `wrangler deploy --dry-run` in each tree, never read the deploy config.
- [ ] **Step 2: Sync and test both trees**, 38 + new tests, tsc.
- [ ] **Step 3: Deploy** sandbox not needed, main worker. Record version. `/health` 200, unauth `/api/sessions` 401.
- [ ] **Step 4: Run `tests/live-automations.mjs`**:
  - create a target chat
  - create a generic webhook automation
  - POST a valid event; wait for assistant reply
  - POST the same event id; assert duplicate and no second run
  - POST a bad secret; assert 401
  - create a watcher against a stable URL; assert no run on unchanged
  - pause/resume and events/runs endpoints
  - cleanup
- [ ] **Step 5: Browser QA** and console errors.
- [ ] **Step 6: Update `tests/README.md`, project memory, design/plan status. No push.**

---

## Subagent work packages

The user asked for explicit subagent plans. These are the packages for a cheap model and its flash children. Each package owns distinct files; do not let two agents edit the same file.

### Package A: Pure store, types, matcher

- Files: `src/automation-types.ts`, `src/automation-store.ts`, `src/automation-match.ts`, `tests/automation-store.test.mjs`, `tests/automation-match.test.mjs`.
- Depends on: none.
- Can run in parallel with B.
- Deliverable: green tests, typecheck, no SDK imports, no secrets.
- Review gate: store dedupe and matcher injection tests.

### Package B: Security and scheduling helpers

- Files: `src/automation-security.ts`, `src/automation-schedule.ts`, tests.
- Depends on: `automation-types.ts` only. A can create the file first, or B can define local types and reconcile.
- Can run in parallel with A after types exist.
- Deliverable: green tests for HMAC, caps, safe URL, fingerprints, due times.

### Package C: Engine

- Files: `src/automation-engine.ts`, `tests/automation-engine.test.mjs`.
- Depends on A and B.
- Must use fakes for session and fetch; real store with node:sqlite.
- Deliverable: every state transition in the design tested.

### Package D: Session origin/completion

- Files: `src/agent.ts`, `src/types.ts` turn origin, `tests/automation-agent.test.mjs`, `tests/submit.test.mjs`.
- Depends on C's `SubmitAutomationInput` shape and `TurnOrigin`.
- Do not edit routes or tools.
- Deliverable: automation origin skips directives, callback fires once, `turnStatus` works, human path unchanged.

### Package E: DO/routes/tools/wiring

- Files: `src/automation-agent.ts`, `src/automation-routes.ts`, `src/automation-tools.ts`, `src/index.ts`, `src/tools.ts`, `src/capabilities.ts`, `src/types.ts` binding, tests.
- Depends on C and D.
- Do not edit `src/agent.ts` except if D explicitly hands off a missing type.
- Deliverable: public hooks and authenticated management routes; three tools; 11-tool set.

### Package F: UI

- Files: `.scratch/ui-rebuild/*`, `ui/index.html`, UI tests.
- Depends on E's final API shapes.
- Do not edit backend files.
- Deliverable: Automations page, detail, Activity, secret-once flow, mobile QA.

### Package G: Verification and records

- Files: `tests/live-automations.mjs`, `tests/README.md`, memory/context notes.
- Depends on deployed E/F.
- No code edits outside its files.
- Deliverable: live evidence and updated records.

### Parallel order

1. Main writes `src/automation-types.ts`.
2. Dispatch A and B in parallel.
3. Main or C builds the engine after A/B pass.
4. Dispatch D while E is prepared.
5. E, then F, then G.
6. Final review by a read-only reviewer on the whole diff.

## Self-review

- Every design section maps to a task: sources (Tasks 3/4), security (3/5/6), UI (7), deploy/live (8), subagent ownership (bottom).
- The critical failure tests are named in the Review Focus and owned by Tasks 3-6.
- Deferred items are explicit: email, OAuth subscriptions, browser, goal integration.
