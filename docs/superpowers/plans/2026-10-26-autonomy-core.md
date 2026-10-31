# Autonomy Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make BLIP able to create, plan, run, verify, budget, audit, pause, and resume durable goals across turns and restarts.

**Architecture:** A new singleton `AutonomyAgent` Durable Object owns goal state and alarms. Every goal gets a dedicated session and a copied workspace. The coordinator plans and verifies with tool-free model calls; each step runs as a normal tool-using turn in the goal session. A session-side write-ahead ledger records tool intents before side effects, and completion flows back to the coordinator only when the whole operation chain is final.

**Tech Stack:** Cloudflare Workers, Durable Objects with SQLite, Agents SDK `ThinkHarness`, AI SDK `generateText`, existing E2B sandbox, existing bearer auth, plain Node 24 tests with `node:sqlite`.

**Spec:** `repo-clone/docs/superpowers/specs/2026-10-26-autonomy-core-design.md`

## Global Constraints

- Edit `repo-clone` first. Mirror changed files to `project/agent-federation` for deploy, but never copy or content-diff the deploy tree's `wrangler.jsonc`.
- Never commit keys, tunnel hosts, relay prefixes, account ids, `.dev.vars`, or `agent_key.local`. Auto memory lives outside the public repo's tracked files.
- No push unless the user asks. Commit only files named by the current task, never `git add -A`.
- Native execution, one writer. Do not dispatch code-editing subagents; read-only review is allowed.
- No new paid dependency and no card. Use the existing free tiers.
- Every goal has a dedicated session. One non-terminal goal per session. Workspace copy failure fails goal creation; never silently start empty.
- One writer per goal and step: a lease token and a run id gate every completion.
- Side-effecting tools are never auto-retried after a crash. An `intent` without `finished` blocks the step.
- Waiting and approval time do not consume active time or a global running slot.
- Payload caps: brief 16 KB, criteria 8 KB, objective 8 KB, checks 16 KB, evidence 32 KB, event 16 KB, instruction 8 KB.
- Default budgets: 30 work steps, 150 tool calls, 6 h active, 2,000,000 tokens best effort, 2 attempts per step, 2 replans, 7 days per wait.
- Global limits: 2 running steps, 10 active goals.
- Goal tools are available to the normal chat agent only, never to a goal step.
- Keep `npm test` silent-or-counted as before, `npx tsc --noEmit` at exit 0, and both trees identical for `src`, `tests`, `ui`, and sandbox worker files.

## Review Focus

- A crash after a tool side effect but before its ledger finish must block automatic retry. Tested in Task 2 (`canAutoRetry` intent case), Task 5 (ledger intent classification), and Task 7 (session wrapper writes intent first).
- A parked approval must not complete the run, consume active time, or hold a global running slot. Tested in Task 4 (`approval parks and releases the slot`) and Task 7 (`parked op does not complete the goal run`).
- A failed or oversize workspace copy must fail goal creation, not start an empty goal. Tested in Task 9 (`copy failure rolls back`, `oversize copy rolls back`).
- Two goals must never share a session, and an active goal session must not be deletable. Tested in Task 1 (`one non-terminal goal per session`) and Task 8 (`delete guard returns 409`).
- Duplicate or mismatched completions must be ignored. Tested in Task 2 (`duplicate run id`), Task 4 (`late and duplicate completion ignored`), and Task 7 (`lease token mismatch`).

---

## File structure

New pure modules:

- `src/goal-types.ts`: shared goal types, budgets, checks, planner/verifier result shapes. No runtime imports.
- `src/goal-store.ts`: `GoalStore` over `SqlHandle`; schema, CRUD, claims, events, attention, instructions, meta.
- `src/goal-machine.ts`: pure decisions for claiming, retries, replans, budgets, active-time, and waiting.
- `src/goal-planner.ts`: planner prompt, JSON parse/validate, one repair, fallback.
- `src/goal-verifier.ts`: verifier prompt, JSON parse/validate, deterministic checks.
- `src/goal-evidence.ts`: build evidence from trusted callbacks, not model text.
- `src/goal-run.ts`: step prompt, exec read-only allowlist, tool effect classification, run usage aggregation.
- `src/goal-supervisor.ts`: orchestration with injected store, session, planner, verifier, clock.
- `src/goal-run-store.ts`: session-side active run, operation, and tool ledger tables.

New runtime modules:

- `src/goal-agent.ts`: `AutonomyAgent` DO; binds `GoalSupervisor` to real services.
- `src/goal-routes.ts`: `/api/goals` family.
- `src/goal-tools.ts`: `goal_create`, `goal_status`, `goal_control`.

Modified modules:

- `src/types.ts`: `Env.AUTONOMY`, goal RPC types, `GoalAgentStub`, `AgentStub` additions.
- `src/index.ts`: export `AutonomyAgent`, route `/api/goals`.
- `src/agent.ts`: session-side goal run RPCs, tool ledger wrapper, usage capture, completion, abort, instruction routing.
- `src/tools.ts`: add goal tools to `ToolDeps` and `buildTools`.
- `src/capabilities.ts`: `EXPECTED_TOOLS` 11 names and the Durable goals capability.
- `src/routes.ts`: export `newSessionId`, add the session-delete guard.
- `deploy/sandbox-worker/src/index.ts`: `/workspace/copy`.
- `deploy/sandbox-worker/workspace.ts`: copy helper if the route needs it.
- `.scratch/ui-rebuild/app.js`, `app.css`, `shell.html`, then `ui/index.html`.

Tests:

- `tests/goal-store.test.mjs`
- `tests/goal-machine.test.mjs`
- `tests/goal-planner.test.mjs`
- `tests/goal-verifier.test.mjs`
- `tests/goal-evidence.test.mjs`
- `tests/goal-run.test.mjs`
- `tests/goal-supervisor.test.mjs`
- `tests/goal-routes.test.mjs`
- `tests/goal-tools.test.mjs`
- `tests/goal-run-store.test.mjs`
- `tests/live-goals.mjs` (live-only)
- updates to `tests/tools.test.mjs`, `tests/paths.test.mjs`, `tests/routes.test.mjs`, `tests/README.md`.

---

### Task 1: Goal types and store

**Files:**
- Create: `src/goal-types.ts`
- Create: `src/goal-store.ts`
- Test: `tests/goal-store.test.mjs`

**Interfaces:**
- Consumes: `SqlHandle` from `src/memory.ts`.
- Produces:
  - types: `GoalStatus`, `StepStatus`, `StepKind`, `Check`, `PlanStep`, `GoalRow`, `StepRow`, `GoalPlanRow`, `GoalRunRow`, `GoalEventRow`, `GoalAttentionRow`, `GoalInstructionRow`, `GoalBudget`, `GoalUsage`, `ToolLedgerSummary`, `NewGoalInput`.
  - `class GoalStore` with `ensureSchema()`, `create(input, now, id)`, `get(id)`, `list(statuses?, limit)`, `update(id, patch)`, `addPlan(goalId, version, planJson, reason, now)`, `addSteps(goalId, version, steps, now)`, `steps(goalId)`, `getStep(id)`, `claimStep(goalId, now, leaseMs, token)`, `updateStep(id, patch)`, `insertRun(run)`, `updateRun(id, patch)`, `addEvent(event)`, `listEvents(goalId, after, limit)`, `addToolCall(call)`, `addAttention(item)`, `listAttention(limit)`, `markAttentionRead(id)`, `addInstruction(goalId, content, now)`, `instructions(goalId)`, `meta(key)`, `setMeta(key, value)`, `activeGoalForSession(sessionId)`, `pruneEvents(goalId, before, limit)`.
- Constants: `DEFAULT_BUDGET: GoalBudget`, `TERMINAL_GOAL_STATUSES`, `TERMINAL_STEP_STATUSES`.

- [ ] **Step 1: Write the failing schema and CRUD tests**

Use `node:sqlite` with the same `SqlHandle` adapter as `tests/artifacts.test.mjs`. Assert:

```js
const store = new GoalStore(sql);
store.ensureSchema();
const goal = store.create({ title: "Ship report", brief: "Write it", success_criteria: "report.md exists", session_id: "gs1", origin_session_id: "chat1" }, 1000, "g1");
assert.equal(goal.status, "planning");
assert.equal(store.get("g1").title, "Ship report");
assert.equal(store.list(["planning"]).length, 1);
assert.equal(store.activeGoalForSession("gs1").id, "g1");
```

Also assert:
- `goal_steps` round-trips `checks_json` and `wake_at`.
- `claimStep` returns the first queued work step and sets `running`, `lease_token`, `lease_until`.
- A second `claimStep` on the same goal returns null because the first step is running.
- The partial unique index rejects a second non-terminal goal on the same session.
- A terminal goal on the same session is allowed.
- `addEvent` and `listEvents(goalId, after, limit)` return oldest first after the cursor.
- Attention `read` filters and marks.
- `setMeta` upserts.
- `create` fills default budget and zero usage.

- [ ] **Step 2: Run the test and watch it fail**

Run: `node tests/goal-store.test.mjs`
Expected: FAIL because `src/goal-store.ts` does not exist.

- [ ] **Step 3: Implement `src/goal-types.ts` and `src/goal-store.ts`**

Use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` for every row shape in the spec. Keep every statement parameterized. Encode JSON columns with `JSON.stringify` and decode with a safe `parseJson` that returns null on bad input. Cap `plan_json`, `checks_json`, `evidence_json`, `result_json`, and event payloads at the spec limits by slicing the serialized string before insert.

The unique index is:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS goals_one_live_per_session
ON goals(session_id)
WHERE status NOT IN ('done', 'cancelled', 'failed');
```

- [ ] **Step 4: Run the store test until green**

Run: `node tests/goal-store.test.mjs`
Expected: PASS.

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npx tsc --noEmit && node tests/run-all.mjs`
Expected: exit 0, one more PASS line than before.

- [ ] **Step 6: Commit only this task**

```bash
git add src/goal-types.ts src/goal-store.ts tests/goal-store.test.mjs
git commit -m "feat: add durable goal schema and store"
```

---

### Task 2: Goal state machine and budgets

**Files:**
- Create: `src/goal-machine.ts`
- Test: `tests/goal-machine.test.mjs`

**Interfaces:**
- Consumes: `GoalRow`, `StepRow`, `GoalBudget`, `GoalUsage`, `Check`.
- Produces:
  - `budgetLevel(budget, usage): "ok" | "warn" | "exhausted"`
  - `stepBudgetExceeded(usage, limits): string | null`
  - `canAutoRetry(input): boolean`
  - `nextClaim(input): ClaimDecision`
  - `applyStepVerdict(input): GoalTransition`
  - `addUsage(a, b): GoalUsage`
  - `countWorkSteps(steps): number`
  - types `ClaimDecision` (`claim`, `wait`, `idle`, `blocked`, `verify`, `done`), `GoalTransition`.

- [ ] **Step 1: Write the failing decision tests**

Assert these cases:

```js
assert.equal(nextClaim({ goal: activeGoal, steps: [queuedStep], now: 100, paused: false, runningCount: 0, maxRunning: 2 }).kind, "claim");
assert.equal(nextClaim({ goal: activeGoal, steps: [queuedStep], now: 100, paused: true, runningCount: 0, maxRunning: 2 }).kind, "idle");
assert.equal(nextClaim({ goal: waitingGoal, steps: [waitStep(500)], now: 100, paused: false, runningCount: 0, maxRunning: 2 }).kind, "wait");
assert.equal(nextClaim({ goal: activeGoal, steps: [queuedStep], now: 100, paused: false, runningCount: 2, maxRunning: 2 }).kind, "idle");
assert.equal(nextClaim({ goal: activeGoal, steps: [], now: 100, paused: false, runningCount: 0, maxRunning: 2 }).kind, "verify");
assert.equal(nextClaim({ goal: doneGoal, steps: allDoneSteps, now: 100, paused: false, runningCount: 0, maxRunning: 2 }).kind, "done");
```

Retry safety:

```js
const ledger = [{ tool: "exec", side_effect: 1, status: "finished" }];
assert.equal(canAutoRetry({ ledger, attempts: 0, maxAttempts: 2 }), false);
assert.equal(canAutoRetry({ ledger: [{ tool: "lookup_online", side_effect: 0, status: "finished" }], attempts: 0, maxAttempts: 2 }), true);
assert.equal(canAutoRetry({ ledger: [{ tool: "write_file", side_effect: 1, status: "intent" }], attempts: 0, maxAttempts: 2 }), false);
```

Budget and verdict cases:
- 70 percent is warn, 100 percent is exhausted.
- Active time over 10 minutes returns a per-step error; waiting and approval time do not.
- A running step whose accepted active time exceeds 10 minutes returns an abort transition.
- `pass` advances; `retry` requeues with feedback; `replan` creates a new plan version and marks unfinished old steps `superseded`; `blocked` writes attention; last-step `pass` with `goalDone:false` replans or blocks.
- A `done` verdict requires every non-superseded work step to be `done`.
- A duplicate completion with the same `run_id` returns `{ kind: "ignore" }`.

- [ ] **Step 2: Run the test and watch it fail**

Run: `node tests/goal-machine.test.mjs`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure decision functions**

No imports except types. Return transitions, do not write to the store. Use the spec's status table and the exact constants. Keep the exec read-only allowlist out of this module; it belongs in `goal-run.ts`.

- [ ] **Step 4: Run green, typecheck, suite**

Run: `node tests/goal-machine.test.mjs && npx tsc --noEmit && node tests/run-all.mjs`
Expected: all pass.

- [ ] **Step 5: Commit only this task**

```bash
git add src/goal-machine.ts tests/goal-machine.test.mjs
git commit -m "feat: add goal state machine and budgets"
```

---

### Task 3: Planner and verifier

**Files:**
- Create: `src/goal-planner.ts`
- Create: `src/goal-verifier.ts`
- Test: `tests/goal-planner.test.mjs`
- Test: `tests/goal-verifier.test.mjs`

**Interfaces:**
- Consumes: `PlanStep`, `Check`, `GoalBudget`, `GoalRow`, `StepRow`.
- Produces:
  - `interface GoalModel { complete(prompt: string, kind: "planner" | "verifier"): Promise<{ text: string; tokens?: number | null }>; }`
  - `plannerPrompt(input): string`
  - `parsePlan(text): { steps: PlanStep[] } | { error: string }`
  - `planGoal(model, input): Promise<{ steps: PlanStep[]; usedFallback: boolean; error?: string; tokens?: number | null }>`
  - `verifierPrompt(input): string`
  - `parseVerdict(text): VerifierResult | null`
  - `verifyStep(model, input): Promise<VerifierResult>`

- [ ] **Step 1: Write planner tests**

Assert:
- A valid 2-step JSON plan parses, including `kind`, `checks`, `wake_at`, and `max_attempts`.
- 13 steps is rejected.
- A missing `done_when` is rejected.
- A text-only check is accepted; an unknown check type is rejected.
- Invalid JSON triggers exactly one repair call; a second invalid reply returns `usedFallback: true` with one step.
- The fallback step's `max_attempts` is 1 and its `done_when` is the goal success criteria.

- [ ] **Step 2: Write verifier tests**

Assert:
- Valid verdicts parse.
- Invalid verdict types and missing evidence citations fail closed to `blocked`.
- Deterministic file, artifact, tool-exit, and forbidden-effect checks run before the model call.
- A failing deterministic check does not call the model.
- A goal-level verifier result with `pass` and `goal_done: false` is treated as `replan`, not done.
- A verifier reply cannot add tools or budgets.

- [ ] **Step 3: Run both tests and watch them fail**

Run: `node tests/goal-planner.test.mjs && node tests/goal-verifier.test.mjs`
Expected: FAIL because both modules are missing.

- [ ] **Step 4: Implement prompts and parsers**

The planner prompt must include the exact brief, success criteria, budget, current time, and workspace summary. It must require the spec's JSON shape and forbid steps that cannot finish in one turn. The verifier prompt must include the goal and step criteria, capped evidence, and a requirement to cite evidence. Parsers extract the first JSON object, validate with narrow shape checks, and never execute.

- [ ] **Step 5: Run green, typecheck, suite**

Run: `node tests/goal-planner.test.mjs && node tests/goal-verifier.test.mjs && npx tsc --noEmit && node tests/run-all.mjs`
Expected: all pass.

- [ ] **Step 6: Commit only this task**

```bash
git add src/goal-planner.ts src/goal-verifier.ts tests/goal-planner.test.mjs tests/goal-verifier.test.mjs
git commit -m "feat: add goal planner and verifier"
```

---

### Task 4: Goal supervisor with injected dependencies

**Files:**
- Create: `src/goal-supervisor.ts`
- Test: `tests/goal-supervisor.test.mjs`

**Interfaces:**
- Consumes: `GoalStore`, `GoalMachine`, `GoalPlanner`, `GoalVerifier`, a `GoalSessionClient`:
  - `startGoalStep(input: StartGoalStepInput): Promise<{ accepted: boolean; error?: string }>`
  - `abortGoalRun(runId: string): Promise<{ aborted: boolean; sideEffects: boolean }>`
  - `appendGoalMessage(sessionId: string, text: string): Promise<void>`
- Produces:
  - `class GoalSupervisor` with `createGoal(input)`, `tick(now)`, `runAccepted(runId, token)`, `completeStep(payload)`, `approvalPending(runId)`, `control(goalId, action, note?)`, `setGlobalPause(paused)`, `get(goalId)`, `list(statuses?, limit)`, `events(goalId, after)`, `attention(limit)`.
  - `interface SupervisorDeps { store; sessions; plan; verify; now(); id(); maxRunning?: number; }`

- [ ] **Step 1: Write failing end-to-end supervisor tests with fakes**

Use a real in-memory `GoalStore` and fake session/planner/verifier. Assert:
- `createGoal` inserts `planning`; `tick` plans, inserts steps, moves to `active`, and calls `startGoalStep` once.
- A `runAccepted` callback starts active time; queued time is excluded.
- A passing completion advances to the next step; the last pass triggers goal verification and `done`.
- A failing verifier with side-effecting ledger blocks, not retries.
- A failing verifier with only read-only ledger retries.
- A replan increments `plan_version`, marks unfinished old steps `superseded`, and starts the new first step.
- A budget exhaustion blocks and writes attention.
- Planner and verifier token counts add to goal usage and can exhaust `max_tokens`.
- The completion payload's tool summaries are copied into `goal_tool_calls` for audit.
- 70 percent and 90 percent budget warnings write one `budget_warning` each, not one per tick.
- A paused goal starts nothing; global pause is checked first.
- `setGlobalPause(true)` aborts a running lease-clean step, requeues it, and blocks a step whose ledger has a side effect.
- A running step over 10 minutes active calls `abortGoalRun` once and blocks on the next tick.
- `tick` prunes old events for at most one goal per pass without touching live rows.
- An approval-parked run releases the running slot, does not consume active time, and resumes after `approvalPending` then completion.
- A stale run with no ledger intent retries; one with intent blocks.
- A late completion with a bad lease token is ignored; a duplicate completes once.
- A done goal posts one deterministic summary to the goal session.

- [ ] **Step 2: Run and watch it fail**

Run: `node tests/goal-supervisor.test.mjs`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the supervisor**

Write state changes before side effects. Use `nextClaim` for eligibility and `applyStepVerdict` for transitions. The supervisor never imports `agents`, `cloudflare:workers`, or `src/agent.ts`; all session calls go through the injected client. The planner and verifier calls go through injected functions. The clock and id generator are injected. Only one step per goal and at most `maxRunning` across goals.

- [ ] **Step 4: Run green, typecheck, suite**

Run: `node tests/goal-supervisor.test.mjs && npx tsc --noEmit && node tests/run-all.mjs`
Expected: all pass.

- [ ] **Step 5: Commit only this task**

```bash
git add src/goal-supervisor.ts tests/goal-supervisor.test.mjs
git commit -m "feat: add goal supervisor"
```

---

### Task 5: Evidence, tool effects, and step prompts

**Files:**
- Create: `src/goal-evidence.ts`
- Create: `src/goal-run.ts`
- Test: `tests/goal-evidence.test.mjs`
- Test: `tests/goal-run.test.mjs`

**Interfaces:**
- Produces:
  - `collectEvidence(checks, sources): Promise<Evidence>` where `sources` supplies `fileInfo(path)`, `artifact(path)`, `toolCalls(runId)`, and `toolExit(tool)`.
  - `classifyToolEffect(tool, input, readOnlyMcp): boolean`
  - `buildStepPrompt(input): string`
  - `aggregateUsage(ops): GoalUsage`
  - `goalRunComplete(ops, pendingApproval): boolean`

- [ ] **Step 1: Write failing evidence tests**

Assert file exists/size/hash, artifact presence, tool exit codes, text checks delegated to the verifier, missing files, and hash mismatch. Assert evidence never contains model prose unless it is a text check. Assert oversized evidence is truncated with an explicit marker.

- [ ] **Step 2: Write failing tool-effect and prompt tests**

Exec allowlist:
- `ls`, `pwd`, `cat file`, `grep x file`, `git status`, `git diff`, `git log`, `find . -name x` are read-only.
- `ls > out`, `python3 x.py`, `rm x`, `find . -delete`, `git commit`, `npm test`, and any pipeline with a non-read-only segment are side-effecting.
- `write_file` is side-effecting unless the ledger has a finished identical path and content hash.
- `mcp_call` is side-effecting unless the server/tool pair is in `readOnlyMcp`.
- `delegate`, `skill_install`, and `schedule_task` are side-effecting.
- `lookup_online` and `skill` are read-only.

Prompt assertions: includes brief, criteria, objective, checks, completed-step digest, instructions, remaining budget; excludes planner/verifier reasoning and any hint that goal tools are available.

- [ ] **Step 3: Run and watch both fail**

Run: `node tests/goal-evidence.test.mjs && node tests/goal-run.test.mjs`
Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement the pure helpers**

`collectEvidence` uses the supplied callbacks only; it never reads the filesystem directly. `classifyToolEffect` parses enough shell syntax to split on `|`, `&&`, `;`, and redirection, and requires every segment to be on the allowlist. `buildStepPrompt` is deterministic and capped.

- [ ] **Step 5: Run green, typecheck, suite**

Run: `node tests/goal-evidence.test.mjs && node tests/goal-run.test.mjs && npx tsc --noEmit && node tests/run-all.mjs`
Expected: all pass.

- [ ] **Step 6: Commit only this task**

```bash
git add src/goal-evidence.ts src/goal-run.ts tests/goal-evidence.test.mjs tests/goal-run.test.mjs
git commit -m "feat: add goal evidence and tool effect helpers"
```

---

### Task 6: Session-side goal run store and RPC contracts

**Files:**
- Create: `src/goal-run-store.ts`
- Test: `tests/goal-run-store.test.mjs`
- Modify: `src/types.ts` (shared RPC input/result types only)

**Interfaces:**
- Produces:
  - `ensureGoalRunSchema(sql)`
  - `startRun(sql, row)`, `getActiveRun(sql, sessionId)`, `updateRun(sql, runId, patch)`
  - `upsertOperation(sql, row)`, `listOperations(sql, runId)`
  - `intentTool(sql, row)`, `finishTool(sql, id, row)`, `listTools(sql, runId)`
  - `interface StartGoalStepInput { sessionId; goalId; stepId; runId; leaseToken; prompt; checks; budget; }`
  - `interface StepCompletion { runId; leaseToken; status; result; evidence; usage; tools: ToolLedgerSummary[]; }`

- [ ] **Step 1: Write failing store tests**

Assert:
- Schema creates `goal_active_runs`, `goal_run_ops`, `goal_run_tools`.
- Starting a run fails when another run is active for the session.
- Operation upsert is idempotent by `operation_id`.
- Tool intent is visible before finish; finish updates the same row.
- An intent with no finish is returned as `status: "intent"`.
- A duplicate finish is ignored.
- Run usage aggregation sums model steps, tool calls, tokens, and active ms across operations.
- `clearRun` removes the active run but preserves ops and tools for audit.

- [ ] **Step 2: Run and watch it fail**

Run: `node tests/goal-run-store.test.mjs`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the schema and functions**

Session-side schema is called from `agent.ts`'s `ensureSchema` path. Use parameterized SQL and the same `SqlHandle` contract. Cap result JSON at 16 KB per tool row.

- [ ] **Step 4: Add shared RPC types to `src/types.ts`**

Add `StartGoalStepInput`, `StartGoalStepReply`, `StepCompletion`, `GoalRunAccepted`, `GoalApprovalPending`, and the new `AgentStub` methods. Do not import goal runtime modules into `types.ts`; duplicate only the small wire shapes if needed to keep it dependency-free.

- [ ] **Step 5: Run green, typecheck, suite**

Run: `node tests/goal-run-store.test.mjs && npx tsc --noEmit && node tests/run-all.mjs`
Expected: all pass.

- [ ] **Step 6: Commit only this task**

```bash
git add src/goal-run-store.ts src/types.ts tests/goal-run-store.test.mjs
git commit -m "feat: add session goal run store"
```

---

### Task 7: Session agent goal run integration

**Files:**
- Modify: `src/agent.ts`
- Modify: `src/types.ts` (`AgentStub` methods)
- Test: `tests/goal-run.test.mjs` (extend)
- Test: `tests/routes.test.mjs` (source checks)

**Interfaces:**
- Consumes: Task 6 store, Task 5 `buildStepPrompt`, `classifyToolEffect`, `aggregateUsage`, `goalRunComplete`; Task 4 session client calls.
- Produces:
  - `startGoalStep(input): Promise<{ ok: boolean; error?: string }>`
  - `abortGoalRun(runId): Promise<{ aborted: boolean; sideEffects: boolean }>`
  - `goalRunAccepted(runId, token): Promise<void>` client call
  - `goalApprovalPending(runId): Promise<void>` client call
  - `appendGoalMessage(sessionId, text, goalId): Promise<void>`
  - `saveWorkspaceForGoal(sessionId): Promise<SnapshotResult>`
  - `adoptWorkspace(sessionId, row): Promise<void>`

- [ ] **Step 1: Add source-level failing checks**

In `tests/routes.test.mjs` or a new `tests/goal-agent.test.mjs`, assert:
- `agent.ts` declares `startGoalStep`, `abortGoalRun`, `appendGoalMessage`, `saveWorkspaceForGoal`, and `adoptWorkspace`.
- The tool wrapper writes an intent before calling `execute` and a finish after.
- The wrapper checks `classifyToolEffect` and never wraps a tool when no goal run is active.
- Goal tools are filtered out when an active goal run exists.
- `finalizeTurn` calls a goal completion hook only after pending approval and continuation checks.
- `mirrorEvent` captures `finish` usage into the active run.
- The session delete path calls `AUTONOMY` before removing a session.

- [ ] **Step 2: Run the checks and watch them fail**

Run: `node tests/goal-run.test.mjs`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement the session RPCs and active run state**

`startGoalStep` validates the lease, stores the prompt and checks, starts a normal turn with the step prompt as a user message, and arms the active run map. It rejects when another run is active. It excludes `goal_create`, `goal_status`, `goal_control`, and `schedule_task` from the tool set. It returns `{ ok: true }` immediately after acceptance.

`abortGoalRun` finds the active run, aborts every operation in `goal_run_ops`, marks the run aborted, clears active state, and returns `{ aborted, sideEffects }` where `sideEffects` is true when any ledger row has `side_effect = 1` in any status.

`appendGoalMessage` logs a trusted assistant message to the transcript without starting a model call.

`saveWorkspaceForGoal` exposes the existing snapshot path as an RPC. `adoptWorkspace` writes a copied `workspace_state` row.

- [ ] **Step 4: Implement the tool ledger wrapper**

In `toolSetFor`, wrap each tool execute with:
1. If no active goal run, call through unchanged.
2. Compute `sideEffect = classifyToolEffect(name, input, readOnlyMcp)`.
3. Insert intent with `run_id`, tool, input hash, side effect.
4. Call the original execute.
5. On success, finish the row with the result summary; on throw, mark failed and rethrow.

The wrapper must not alter results and must not write when the tool is a goal tool (goal tools are not in the set anyway).

- [ ] **Step 5: Implement usage, completion, and approval hooks**

On `run-start`, increment model steps for the active run and upsert the operation. On `chunk.type === "finish"` with usage, add tokens. On each operation finalization, mark the operation done/failed. In `finalizeTurn`, before finishing the stream, if an active goal run exists:
- if a continuation will start, do nothing;
- if a pending approval exists, call `goalApprovalPending` and leave the run active;
- otherwise collect evidence, aggregate usage, read the compact tool ledger, clear the run, and call `AUTONOMY.completeGoalStep` with the lease token and tool summaries.

If the completion callback fails, log and retry once with backoff; the coordinator's stale-run rules are the final fallback.

- [ ] **Step 6: Route goal-session instructions and guard delete**

When a normal message route targets a session with an active goal, return 409 with `goal_session` and the goal id. The UI sends the text to `/api/goals/:id/control` with `action: instruct` instead. In `deleteSession`, before removing anything, ask `AUTONOMY.blocksDelete(id)`; if true, return 409 with the goal id.

- [ ] **Step 7: Run tests, typecheck, suite**

Run: `node tests/goal-run.test.mjs && node tests/routes.test.mjs && npx tsc --noEmit && node tests/run-all.mjs`
Expected: all pass.

- [ ] **Step 8: Commit only this task**

```bash
git add src/agent.ts src/types.ts tests/goal-run.test.mjs tests/routes.test.mjs
git commit -m "feat: run durable goals inside session agents"
```

---

### Task 8: Coordinator DO, routes, agents tools, and binding

**Files:**
- Create: `src/goal-agent.ts`
- Create: `src/goal-routes.ts`
- Create: `src/goal-tools.ts`
- Modify: `src/types.ts` (`Env.AUTONOMY`, `GoalAgentStub`)
- Modify: `src/index.ts` (export and route)
- Modify: `src/tools.ts` (`ToolDeps` goal methods and `buildTools`)
- Modify: `src/capabilities.ts` (`EXPECTED_TOOLS` 11)
- Modify: `src/agent.ts` (`toolDeps` goal bindings)
- Test: `tests/goal-routes.test.mjs`
- Test: `tests/goal-tools.test.mjs`
- Modify: `tests/tools.test.mjs`

**Interfaces:**
- Produces:
  - `AutonomyAgent extends Agent<Env>` with `alarm()`, `createGoal(input)`, `getGoal(id)`, `listGoals(statuses, limit)`, `goalEvents(id, after)`, `controlGoal(id, action, note?)`, `setGlobalPause(paused)`, `attention(limit)`, `blocksDelete(sessionId)`, `completeGoalStep(payload)`, `runAccepted(runId, token)`, `approvalPending(runId)`, `addInstruction(goalId, content)`.
  - `handleGoals(request, env): Promise<Response | null>` for `/api/goals`.
  - `isGoalId(id): boolean` with `/^[a-z0-9]{8,32}$/` and a matching test; reserved segments such as `attention` are handled before the `:id` branch.
  - three tool builders.

- [ ] **Step 1: Write failing route tests**

Use a fake `env.AUTONOMY` namespace/stub. Assert:
- `/api/goals` rejects without the bearer.
- `POST /api/goals` validates title, brief, and criteria; rejects empty or oversized.
- `POST` returns 202 with the goal and goal session id.
- `GET /api/goals?status=active` forwards status and limit.
- `GET /api/goals/:id` returns 404 for a missing id.
- `control` maps pause, resume, cancel, retry, instruct, budget; rejects unknown actions and budget/retry from the chat tool.
- `GET /api/goals/attention` is matched before the `/:id` branch and returns rows.
- `POST /api/goals/pause-all` and `/resume-all` set the global flag and are idempotent.
- An invalid goal id is a 400 before any DO call.
- `DELETE /api/sessions/:id` returns 409 when `blocksDelete` is true, before any registry deletion.

- [ ] **Step 2: Write failing tool tests**

Assert:
- `EXPECTED_TOOLS` has eleven names and the capability table has a Durable goals row.
- `goal_create` requires title, brief, success criteria; clamps budget to server maxima; returns one line containing the goal id and goal session id for the card linker.
- `goal_status` calls the coordinator with an optional id.
- `goal_control` exposes only pause, resume, cancel, instruct.
- No step turn can receive the goal tools; `buildTools` supports a name list excluding them.
- Tool descriptions state when to use goals and that goals are durable.

- [ ] **Step 3: Run and watch both fail**

Run: `node tests/goal-routes.test.mjs && node tests/goal-tools.test.mjs`
Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement `AutonomyAgent`**

Bind `GoalStore` to `this.sql` and `GoalSupervisor` to:
- a `SessionGoalClient` over `env.FEDERATION_AGENT`,
- planner/verifier functions using AI SDK `generateText` with `createPrimaryModel(env)` and a strict tool-free prompt,
- real clock and id generator.

`alarm()` calls `supervisor.tick(Date.now())`, then re-arms for the soonest wait/lease. `onStart()` ensures schema, loads the pause flag, and re-arms. The DO is a singleton named `"autonomy"`.

`createGoal` creates the registry row for the dedicated session and calls a `prepareGoalSession` dependency. Until Task 9 lands, that dependency creates an empty session; Task 9 replaces it with the workspace copy.

`completeGoalStep` verifies the lease token and run id, stores the completion's tool summaries in `goal_tool_calls`, then hands the completion to the supervisor. A mismatched or duplicate run is ignored and audited.

- [ ] **Step 5: Implement routes, tools, and wiring**

Add `AUTONOMY: DurableObjectNamespace` to `Env`. Add `export { AutonomyAgent }` and route `/api/goals` before the sessions handler. Add the goal tools to `ToolDeps` by calling the `AUTONOMY` stub. Add the capability row and update `EXPECTED_TOOLS`.

- [ ] **Step 6: Run green, typecheck, suite**

Run: `node tests/goal-routes.test.mjs && node tests/goal-tools.test.mjs && npx tsc --noEmit && node tests/run-all.mjs`
Expected: all pass.

- [ ] **Step 7: Commit only this task**

```bash
git add src/goal-agent.ts src/goal-routes.ts src/goal-tools.ts src/types.ts src/index.ts src/tools.ts src/capabilities.ts src/agent.ts tests/goal-routes.test.mjs tests/goal-tools.test.mjs tests/tools.test.mjs
git commit -m "feat: expose durable goals to the agent and console"
```

---

### Task 9: Workspace copy and goal session preparation

**Files:**
- Modify: `deploy/sandbox-worker/src/index.ts`
- Modify: `deploy/sandbox-worker/workspace.ts`
- Modify: `src/goal-agent.ts` (real preparer)
- Modify: `src/routes.ts` (export `newSessionId`)
- Test: `tests/paths.test.mjs`
- Test: `tests/goal-routes.test.mjs`
- Test: `tests/workspace.test.mjs` if a pure copy helper is added

**Interfaces:**
- Consumes: origin session `saveWorkspaceForGoal`, goal session `adoptWorkspace`, sandbox worker `/workspace/copy`.
- Produces:
  - `copyWorkspace(env, fromSession, toSession): Promise<{ ok; bytes; files; sha256; error? }>`
  - `POST /workspace/copy` accepts `{ from, to }` with bearer auth and returns the copied manifest.

- [ ] **Step 1: Write failing path and route tests**

Assert:
- `POST /workspace/copy` rejects a missing bearer and invalid session ids.
- The route reads the origin tar and manifest and writes the destination keys.
- A missing origin archive returns `no_snapshot`; if the origin session reported `reason: "empty"` the goal may start empty, otherwise goal creation fails closed.
- An archive over the existing cap returns `too_large`; goal creation fails closed.
- Goal creation rolls back the registry row and goal row on copy failure.
- A successful copy seeds the goal session workspace state with the origin bytes/files/hash.

- [ ] **Step 2: Run and watch the tests fail**

Run: `node tests/paths.test.mjs && node tests/goal-routes.test.mjs`
Expected: FAIL on the new route and rollback assertions.

- [ ] **Step 3: Implement the sandbox copy route and helper**

Reuse `tarKey` and `manifestKey` from `workspace.ts`. Validate both ids with the existing safe session id rule. Read both KV entries, reject a missing tar, reject an oversize tar, write both to the destination keys, and return the manifest. Do not boot a sandbox for a plain copy.

- [ ] **Step 4: Wire the goal preparer**

`AutonomyAgent.createGoal`:
1. Insert a registry row with title `Goal: <title>`.
2. If an origin session is given, call its `saveWorkspaceForGoal`; if the result is empty, continue empty; if it fails, roll back.
3. Call the sandbox copy route; on `no_snapshot`, continue empty only when the origin reported no workspace; otherwise roll back.
4. Call the goal session `adoptWorkspace` with the copied manifest.
5. Insert the goal row and return.

Rollback removes the registry row, clears the goal session's workspace, and never leaves a `planning` goal.

- [ ] **Step 5: Run green, typecheck, suite**

Run: `node tests/paths.test.mjs && node tests/goal-routes.test.mjs && npx tsc --noEmit && node tests/run-all.mjs`
Expected: all pass.

- [ ] **Step 6: Commit only this task**

```bash
git add deploy/sandbox-worker/src/index.ts deploy/sandbox-worker/workspace.ts src/goal-agent.ts src/routes.ts tests/paths.test.mjs tests/goal-routes.test.mjs tests/workspace.test.mjs
git commit -m "feat: copy chat workspace into goal sessions"
```

---

### Task 10: Goals UI, activity, and controls

**Files:**
- Modify: `.scratch/ui-rebuild/app.js`
- Modify: `.scratch/ui-rebuild/app.css`
- Modify: `.scratch/ui-rebuild/shell.html`
- Build: `repo-clone/ui/index.html` via `.scratch/ui-rebuild/build.mjs`
- Test: `tests/ui.test.mjs` or the existing UI source checks

**Interfaces:**
- Consumes: `/api/goals`, `/api/goals/:id`, `/api/goals/:id/events`, `/api/goals/:id/control`, `/api/goals/attention`, `/api/sessions`.
- Produces: Goals tab, goal detail, Activity card, global pause, instruction routing.

- [ ] **Step 1: Write failing UI source checks**

Assert:
- The nav label is Goals and Tasks is gone.
- The page renders Active, Needs you, Waiting, Done sections.
- The goal detail has pause, resume, cancel, retry, instruct, and budget controls.
- The activity inspector shows a goal card with step and active time.
- The goal session composer sends to the goal instruction route when a goal is active.
- The build output contains the new strings and the script still has one block.
- `tests/ui.test.mjs` extracts the one `<script>` block to a temp file, runs `node --check` on it, and asserts exit 0.

- [ ] **Step 2: Run and watch fail**

Run: `node tests/ui.test.mjs`
Expected: FAIL on the new strings.

- [ ] **Step 3: Implement data loading and the Goals page**

Add a `GOALS` state, `loadGoals()`, `loadGoal(id)`, `loadGoalEvents(id, after)`, `loadAttention()`, and a 3s poll only while the Goals page or a goal detail is open. Re-render only when the signature changes so clicks are not stolen.

Replace `pTasks` with `pGoals`; keep scheduled jobs in a `Scheduled` panel fed by `TASKS`. Add a New goal dialog (title, brief, success criteria, budget preset). Add goal detail in the page pane; on mobile it is full-width. Render a compact goal card for `goal_create` tool runs in the origin chat with the goal title and an Open goal link, reading the id from the tool output.

- [ ] **Step 4: Implement controls and Activity**

Buttons call `/api/goals/:id/control` with the right action. Show a confirm for cancel and retry when the goal has side effects. Add a global Pause all / Resume all button that calls `POST /api/goals/pause-all` and `POST /api/goals/resume-all`.

The Activity inspector shows the newest active or blocked goal: title, current step, active time, budget meter, and an Open action. It links to the goal detail, not a new chat.

- [ ] **Step 5: Implement goal-session instruction mode**

When the current session has an active goal, show an "Instruction to goal" banner and send the composer text to the instruct action instead of `/message`. Show a toast when stored. Keep the normal composer after the goal is terminal. The origin chat is unaffected.

- [ ] **Step 6: Build, check, and run the suite**

Run: `node .scratch/ui-rebuild/build.mjs && node tests/ui.test.mjs && node tests/run-all.mjs`
Expected: build reports the new byte count, the UI test's extracted `node --check` exits 0, and UI checks pass.

- [ ] **Step 7: Browser QA**

Open the live console, create a goal from a chat with a file, confirm the goal session appears, the copied file is listed, the Goals page shows planning then active, the Activity card updates, pause stops the next step, cancel is immediate, and a blocked goal shows Needs you. Capture desktop and mobile screenshots and check the console for zero errors.

- [ ] **Step 8: Commit only this task**

```bash
git add .scratch/ui-rebuild/app.js .scratch/ui-rebuild/app.css .scratch/ui-rebuild/shell.html ui/index.html tests/ui.test.mjs
git commit -m "feat: add the goals console"
```

---

### Task 11: Deploy, live verification, and records

**Files:**
- Modify: deploy tree `wrangler.jsonc` (manual insertion only; never content-diff or copy)
- Modify: `repo-clone/wrangler.jsonc` if it declares the DO bindings
- Create: `tests/live-goals.mjs`
- Modify: `tests/README.md`
- Update: project memory and context notes

**Interfaces:**
- Consumes: all previous tasks.
- Produces: deployed `AutonomyAgent`, live goal flow, documented counts and deploy versions.

- [ ] **Step 1: Add the DO binding and migration in both trees**

In `repo-clone/wrangler.jsonc`, add `AUTONOMY` to `durable_objects.bindings` and the new class to the migration. In the deploy tree, perform the equivalent manual edit without printing, copying, or diffing the file. Verify with `npx wrangler deploy --dry-run` in each tree, not by reading the deploy config.

- [ ] **Step 2: Sync and run both suites**

Mirror only the changed files. Run `npx tsc --noEmit && npm test` in both trees. Run the sandbox worker typecheck if its files changed. Expected: all 38 plus the new goal test files pass in both trees.

- [ ] **Step 3: Deploy**

Deploy the sandbox worker if `/workspace/copy` changed, then the main worker from `project/agent-federation`. Record both version ids. Check `/health` 200 and unauthenticated `/api/sessions` 401.

- [ ] **Step 4: Write and run the live goal script**

`tests/live-goals.mjs` creates a chat, writes a file, creates a goal from that chat, and asserts:
- the goal session exists and the file was copied;
- the goal reaches active and posts agent progress;
- the goal reaches done or a clear blocked state;
- the Goals list and events endpoints reflect it;
- pause/cancel works on a second goal;
- deleting the origin chat does not affect the goal;
- deleting the active goal session returns 409.

Run with `BLIP_URL=<origin> node tests/live-goals.mjs`. Read the final `PASS` or `FAIL`, not just the exit code from a redirect.

- [ ] **Step 5: Run the existing live matrix and browser QA**

Run the existing matrix and at least one ordinary chat turn to prove goals did not regress the chat loop. Confirm no new console errors. Capture the final Goals screens.

- [ ] **Step 6: Update records**

Update `tests/README.md` with the new offline count, the live-only list, and the goal script. Update project memory with the design path, deploy versions, test counts, and any open gaps. Do not write keys or hosts into tracked files.

- [ ] **Step 7: Final verification and commit**

Run the full suite once more in both trees, `diff -r --brief` over `src`, `tests`, and `ui` (never the deploy wrangler), and confirm the mirror is clean. Commit only the task files. Do not push.

---

## Self-review notes

- Spec coverage: every spec section maps to Task 1 through Task 11. The only deliberate gap is external notification delivery, which is the next project.
- Type consistency: `GoalStore` methods, `GoalSupervisor` dependencies, session RPC names, and route actions are used consistently across tasks.
- Review Focus tests are placed in the owning tasks and repeated in the review header.
- No task requires a subagent fleet, a new paid service, or a public repo secret.
