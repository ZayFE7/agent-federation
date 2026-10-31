// Pure goal-machine cases: budgets, per-step limits, retry safety, claims,
// waits, pauses, replans, duplicate completions, and verdict transitions.
// No SQLite and no store writes.

import assert from "node:assert/strict";
import { DEFAULT_BUDGET } from "../src/goal-types.ts";
import {
  addUsage,
  applyStepVerdict,
  budgetLevel,
  budgetWarningLevel,
  budgetWarningsCrossed,
  canAutoRetry,
  countWorkSteps,
  nextClaim,
  stepBudgetExceeded,
} from "../src/goal-machine.ts";

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
    console.log("  FAIL " + name);
  }
}

function usage(over = {}) {
  return {
    steps: 0,
    tool_calls: 0,
    active_ms: 0,
    tokens: 0,
    model_steps: 0,
    replans: 0,
    ...over,
  };
}

function goal(over = {}) {
  return {
    id: "g1",
    session_id: "gs1",
    origin_session_id: null,
    workspace_source: "empty",
    title: "Ship report",
    brief: "Write it",
    success_criteria: "report.md exists",
    status: "active",
    paused: 0,
    plan_version: 1,
    budget_json: JSON.stringify(DEFAULT_BUDGET),
    usage_json: JSON.stringify(usage()),
    current_step_id: null,
    summary: null,
    last_error: null,
    created_at: 1,
    updated_at: 1,
    started_at: 1,
    finished_at: null,
    ...over,
  };
}

function step(over = {}) {
  return {
    id: "st1",
    goal_id: "g1",
    plan_version: 1,
    seq: 1,
    kind: "work",
    title: "Write it",
    objective: "Write report.md",
    done_when: "report.md exists",
    checks_json: "[]",
    status: "queued",
    attempts: 0,
    max_attempts: 2,
    wake_at: null,
    lease_token: null,
    lease_until: null,
    evidence_json: null,
    result_json: null,
    last_error: null,
    created_at: 1,
    updated_at: 1,
    started_at: null,
    finished_at: null,
    ...over,
  };
}

function readOnlyCall(over = {}) {
  return {
    tool: "lookup_online",
    input_hash: "h1",
    side_effect: 0,
    status: "finished",
    ...over,
  };
}

check("budgetLevel warns at 70 and 90 and exhausts at 100", () => {
  const budget = {
    ...DEFAULT_BUDGET,
    max_steps: 10,
    max_tool_calls: 10,
    max_active_ms: 1000,
    max_tokens: 1000,
  };
  assert.equal(budgetLevel(budget, usage()), "ok");
  assert.equal(budgetLevel(budget, usage({ steps: 6 })), "ok");
  assert.equal(budgetLevel(budget, usage({ steps: 7 })), "warn");
  assert.equal(budgetLevel(budget, usage({ steps: 9 })), "warn");
  assert.equal(budgetLevel(budget, usage({ steps: 10 })), "exhausted");
  assert.equal(budgetLevel(budget, usage({ tool_calls: 10 })), "exhausted");
  assert.equal(budgetLevel(budget, usage({ active_ms: 1000 })), "exhausted");
  assert.equal(budgetLevel(budget, usage({ tokens: 1000 })), "exhausted");

  assert.equal(budgetWarningLevel(budget, usage({ steps: 5 })), null);
  assert.equal(budgetWarningLevel(budget, usage({ steps: 7 })), 70);
  assert.equal(budgetWarningLevel(budget, usage({ steps: 9 })), 90);
  assert.deepEqual(
    budgetWarningsCrossed(budget, usage({ steps: 6 }), usage({ steps: 7 })),
    [70]
  );
  assert.deepEqual(
    budgetWarningsCrossed(budget, usage({ steps: 8 }), usage({ steps: 9 })),
    [90]
  );
  assert.deepEqual(
    budgetWarningsCrossed(budget, usage({ steps: 6 }), usage({ steps: 9 })),
    [70, 90]
  );
  assert.deepEqual(
    budgetWarningsCrossed(budget, usage({ steps: 9 }), usage({ steps: 9 })),
    []
  );
});

check("stepBudgetExceeded enforces 12 model steps, 20 tool calls, 10 active minutes", () => {
  assert.equal(
    stepBudgetExceeded({ model_steps: 12, tool_calls: 20, active_ms: 600_000 }),
    null
  );
  assert.match(stepBudgetExceeded({ model_steps: 13 }), /model_steps/);
  assert.match(stepBudgetExceeded({ tool_calls: 21 }), /tool_calls/);
  assert.match(stepBudgetExceeded({ active_ms: 600_001 }), /active_ms/);
  // Waiting and approval time are never part of active_ms.
  assert.equal(
    stepBudgetExceeded(
      { active_ms: 600_001, wait_ms: 30 * 24 * 60 * 60 * 1000, approval_ms: 99_000_000 },
      { max_active_ms: 700_000 }
    ),
    null
  );
  assert.match(
    stepBudgetExceeded({ active_ms: 700_001 }, { max_active_ms: 700_000 }),
    /active_ms/
  );
});

check("canAutoRetry blocks any side effect, any intent, and the attempt limit", () => {
  assert.equal(
    canAutoRetry({
      ledger: [{ tool: "exec", input_hash: "h", side_effect: 1, status: "finished" }],
      attempts: 0,
      maxAttempts: 2,
    }),
    false
  );
  assert.equal(
    canAutoRetry({ ledger: [readOnlyCall()], attempts: 0, maxAttempts: 2 }),
    true
  );
  assert.equal(
    canAutoRetry({
      ledger: [{ tool: "write_file", input_hash: "h", side_effect: 1, status: "intent" }],
      attempts: 0,
      maxAttempts: 2,
    }),
    false
  );
  assert.equal(
    canAutoRetry({
      ledger: [readOnlyCall({ status: "intent" })],
      attempts: 0,
      maxAttempts: 2,
    }),
    false
  );
  assert.equal(
    canAutoRetry({ ledger: [readOnlyCall({ status: "failed" })], attempts: 0, maxAttempts: 2 }),
    true
  );
  assert.equal(canAutoRetry({ ledger: [], attempts: 2, maxAttempts: 2 }), false);
  assert.equal(canAutoRetry({ ledger: [], attempts: 1, maxAttempts: 2 }), true);
});

check("addUsage sums every counter and countWorkSteps skips superseded and skipped", () => {
  assert.deepEqual(
    addUsage(
      usage({ steps: 1, tokens: 5 }),
      usage({ steps: 2, tool_calls: 3, tokens: 7, model_steps: 1, active_ms: 10, replans: 1 })
    ),
    {
      steps: 3,
      tool_calls: 3,
      active_ms: 10,
      tokens: 12,
      model_steps: 1,
      replans: 1,
    }
  );
  assert.deepEqual(addUsage(null, undefined), usage());
  assert.equal(
    countWorkSteps([
      step({ id: "a", status: "done" }),
      step({ id: "b", status: "superseded" }),
      step({ id: "c", status: "skipped" }),
      step({ id: "d", kind: "wait", status: "queued" }),
      step({ id: "e", status: "queued" }),
    ]),
    2
  );
});

check("nextClaim claims eligible work, respects pause and the global cap", () => {
  const queued = step();
  const base = {
    goal: goal(),
    steps: [queued],
    now: 100,
    paused: false,
    runningCount: 0,
    maxRunning: 2,
  };
  const claim = nextClaim(base);
  assert.equal(claim.kind, "claim");
  assert.equal(claim.step.id, "st1");

  assert.equal(nextClaim({ ...base, paused: true }).kind, "idle");
  assert.equal(
    nextClaim({ ...base, goal: goal({ paused: 1 }), paused: false }).kind,
    "idle"
  );
  assert.equal(
    nextClaim({ ...base, runningCount: 2, maxRunning: 2 }).kind,
    "idle"
  );
  assert.equal(
    nextClaim({ ...base, goal: goal({ status: "planning" }) }).kind,
    "idle"
  );
});

check("nextClaim waits on future wait steps and hands back an elapsed wait", () => {
  const wait = step({ id: "wait1", kind: "wait", wake_at: 500, seq: 1 });
  const work = step({ id: "work1", kind: "work", seq: 2 });
  const base = {
    goal: goal({ status: "waiting" }),
    steps: [wait, work],
    now: 100,
    paused: false,
    runningCount: 0,
    maxRunning: 2,
  };
  const waiting = nextClaim(base);
  assert.equal(waiting.kind, "wait");
  assert.equal(waiting.step.id, "wait1");
  assert.equal(waiting.wakeAt, 500);

  const elapsed = nextClaim({ ...base, now: 500 });
  assert.equal(elapsed.kind, "claim");
  assert.equal(elapsed.step.id, "wait1");
});

check("nextClaim verifies empty plans and finishes all-done or terminal goals", () => {
  const base = {
    goal: goal(),
    steps: [],
    now: 100,
    paused: false,
    runningCount: 0,
    maxRunning: 2,
  };
  assert.equal(nextClaim(base).kind, "verify");
  assert.equal(
    nextClaim({ ...base, goal: goal({ status: "done" }), steps: [step({ status: "done" })] })
      .kind,
    "done"
  );
  assert.equal(
    nextClaim({ ...base, goal: goal({ status: "cancelled" }), steps: [step()] }).kind,
    "done"
  );
  assert.equal(
    nextClaim({ ...base, steps: [step({ status: "done" })] }).kind,
    "done"
  );
  assert.equal(
    nextClaim({ ...base, goal: goal({ status: "verifying" }), steps: [step()] }).kind,
    "verify"
  );
});

check("nextClaim is idle on a running step and blocked on budget or a stuck step", () => {
  const running = step({ status: "running", seq: 1 });
  const queued = step({ id: "st2", seq: 2 });
  const base = {
    goal: goal(),
    steps: [running, queued],
    now: 100,
    paused: false,
    runningCount: 0,
    maxRunning: 2,
  };
  assert.equal(nextClaim(base).kind, "idle");

  const exhausted = nextClaim({
    ...base,
    steps: [queued],
    budget: { ...DEFAULT_BUDGET, max_steps: 1 },
    usage: usage({ steps: 1 }),
  });
  assert.equal(exhausted.kind, "blocked");
  assert.equal(exhausted.reason, "budget_exhausted");

  assert.equal(
    nextClaim({ ...base, goal: goal({ status: "blocked" }), steps: [queued] }).kind,
    "blocked"
  );
  assert.equal(
    nextClaim({
      ...base,
      steps: [step({ id: "failed1", seq: 1, status: "failed" }), queued],
    }).kind,
    "blocked"
  );
});

check("a pass advances and never mutates the input steps", () => {
  const first = step({ id: "s1", seq: 1, status: "running" });
  const second = step({ id: "s2", seq: 2, status: "queued" });
  const transition = applyStepVerdict({
    goal: goal(),
    step: first,
    steps: [first, second],
    verdict: "pass",
  });
  assert.equal(transition.kind, "advance");
  assert.equal(transition.goalStatus, "active");
  assert.equal(transition.stepStatus, "done");
  assert.equal(transition.nextStepId, "s2");
  assert.equal(first.status, "running");
  assert.equal(second.status, "queued");
});

check("a pass into a wait goes to waiting with the wake time", () => {
  const first = step({ id: "s1", seq: 1, status: "running" });
  const wait = step({ id: "w1", seq: 2, kind: "wait", wake_at: 9000 });
  const transition = applyStepVerdict({
    goal: goal(),
    step: first,
    steps: [first, wait],
    verdict: "pass",
  });
  assert.equal(transition.kind, "advance");
  assert.equal(transition.goalStatus, "waiting");
  assert.equal(transition.nextStepId, "w1");
  assert.equal(transition.waitAt, 9000);
});

check("a last-step pass verifies; goal_done true completes and false replans", () => {
  const only = step({ status: "running" });
  const verified = applyStepVerdict({
    goal: goal(),
    step: only,
    steps: [only],
    verdict: "pass",
  });
  assert.equal(verified.kind, "verify");
  assert.equal(verified.goalStatus, "verifying");
  assert.equal(verified.stepStatus, "done");

  const done = applyStepVerdict({
    goal: goal({ status: "verifying" }),
    step: only,
    steps: [only],
    verdict: "pass",
    goalDone: true,
  });
  assert.equal(done.kind, "done");
  assert.equal(done.goalStatus, "done");

  const alias = applyStepVerdict({
    goal: goal({ status: "verifying" }),
    step: only,
    steps: [only],
    verdict: "pass",
    goal_done: true,
  });
  assert.equal(alias.kind, "done");

  const replan = applyStepVerdict({
    goal: goal(),
    step: only,
    steps: [only],
    verdict: "pass",
    goalDone: false,
  });
  assert.equal(replan.kind, "replan");
  assert.equal(replan.version, 2);
  assert.deepEqual(replan.supersededStepIds, []);
  assert.equal(replan.reason, "goal_not_done");
});

check("last-step pass with goal_done false blocks when replans are exhausted", () => {
  const only = step({ plan_version: 3, status: "running" });
  const blocked = applyStepVerdict({
    goal: goal({ plan_version: 3 }),
    step: only,
    steps: [only],
    verdict: "pass",
    goalDone: false,
    budget: { ...DEFAULT_BUDGET, max_replans: 2 },
    usage: usage({ replans: 2 }),
  });
  assert.equal(blocked.kind, "blocked");
  assert.equal(blocked.goalStatus, "blocked");
  assert.equal(blocked.attentionKind, "budget_exhausted");
  assert.match(blocked.reason, /replan_limit/);

  const zeroBudget = applyStepVerdict({
    goal: goal(),
    step: step({ status: "running" }),
    steps: [],
    verdict: "pass",
    goalDone: false,
    budget: { ...DEFAULT_BUDGET, max_replans: 0 },
  });
  assert.equal(zeroBudget.kind, "blocked");
});

check("a replan increments the version and supersedes only unfinished steps", () => {
  const done = step({ id: "done1", seq: 0, status: "done" });
  const first = step({ id: "s1", seq: 1, status: "running" });
  const second = step({ id: "s2", seq: 2, status: "queued" });
  const transition = applyStepVerdict({
    goal: goal(),
    step: first,
    steps: [done, first, second],
    verdict: "replan",
    reason: "new approach",
  });
  assert.equal(transition.kind, "replan");
  assert.equal(transition.goalStatus, "planning");
  assert.equal(transition.version, 2);
  assert.equal(transition.reason, "new approach");
  assert.deepEqual(transition.supersededStepIds, ["s1", "s2"]);
});

check("replan verdict blocks once the replan budget is spent", () => {
  const transition = applyStepVerdict({
    goal: goal({ plan_version: 3 }),
    step: step({ plan_version: 3, status: "running" }),
    steps: [],
    verdict: "replan",
    budget: { ...DEFAULT_BUDGET, max_replans: 2 },
    usage: usage({ replans: 2 }),
  });
  assert.equal(transition.kind, "blocked");
  assert.equal(transition.attentionKind, "budget_exhausted");
});

check("a done verdict requires every non-superseded work step to be done", () => {
  const first = step({ id: "s1", seq: 1, status: "running" });
  const second = step({ id: "s2", seq: 2, status: "queued" });
  const premature = applyStepVerdict({
    goal: goal({ status: "verifying" }),
    step: first,
    steps: [first, second],
    verdict: "done",
  });
  assert.equal(premature.kind, "blocked");
  assert.equal(premature.reason, "done_requires_all_work_steps");

  const finished = step({ id: "s2", seq: 2, status: "done" });
  const done = applyStepVerdict({
    goal: goal({ status: "verifying" }),
    step: first,
    steps: [first, finished],
    verdict: "done",
  });
  assert.equal(done.kind, "done");
  assert.equal(done.goalStatus, "done");
});

check("retry requeues only a side-effect-free, in-limit step", () => {
  const running = step({ status: "running", attempts: 1, max_attempts: 2 });
  const retry = applyStepVerdict({
    goal: goal(),
    step: running,
    verdict: "retry",
    feedback: "Add the citation",
    ledger: [readOnlyCall()],
  });
  assert.equal(retry.kind, "retry");
  assert.equal(retry.goalStatus, "active");
  assert.equal(retry.stepStatus, "queued");
  assert.equal(retry.attempts, 1);
  assert.equal(retry.feedback, "Add the citation");

  const sideEffect = applyStepVerdict({
    goal: goal(),
    step: running,
    verdict: "retry",
    ledger: [{ tool: "exec", input_hash: "h", side_effect: 1, status: "finished" }],
  });
  assert.equal(sideEffect.kind, "blocked");
  assert.equal(sideEffect.reason, "side_effect_retry_blocked");

  const intent = applyStepVerdict({
    goal: goal(),
    step: running,
    verdict: "retry",
    ledger: [readOnlyCall({ status: "intent" })],
  });
  assert.equal(intent.kind, "blocked");
  assert.equal(intent.reason, "side_effect_retry_blocked");

  const exhausted = applyStepVerdict({
    goal: goal(),
    step: step({ status: "running", attempts: 2, max_attempts: 2 }),
    verdict: "retry",
    ledger: [readOnlyCall()],
  });
  assert.equal(exhausted.kind, "blocked");
  assert.equal(exhausted.reason, "retry_limit_reached");
});

check("a blocked verdict blocks the goal and keeps the step for review", () => {
  const transition = applyStepVerdict({
    goal: goal(),
    step: step({ status: "running" }),
    verdict: "blocked",
    reason: "missing credential",
  });
  assert.equal(transition.kind, "blocked");
  assert.equal(transition.goalStatus, "blocked");
  assert.equal(transition.stepStatus, "blocked");
  assert.equal(transition.attentionKind, "blocked");
  assert.equal(transition.reason, "missing credential");
});

check("duplicate run ids, terminal goals, superseded steps, and replayed passes are ignored", () => {
  const running = step({ status: "running" });
  assert.equal(
    applyStepVerdict({
      goal: goal(),
      step: running,
      verdict: "pass",
      runId: "run1",
      appliedRunIds: ["run1"],
    }).kind,
    "ignore"
  );
  assert.equal(
    applyStepVerdict({
      goal: goal(),
      step: running,
      verdict: "pass",
      runId: "run2",
      lastRunId: "run2",
    }).kind,
    "ignore"
  );
  assert.equal(
    applyStepVerdict({
      goal: goal({ status: "cancelled" }),
      step: running,
      verdict: "pass",
    }).kind,
    "ignore"
  );
  assert.equal(
    applyStepVerdict({
      goal: goal(),
      step: step({ status: "superseded" }),
      verdict: "pass",
    }).kind,
    "ignore"
  );
  assert.equal(
    applyStepVerdict({
      goal: goal(),
      step: step({ status: "done" }),
      verdict: "pass",
    }).kind,
    "ignore"
  );
});

check("over ten minutes of accepted active time aborts the run", () => {
  const running = step({ status: "running" });
  const aborted = applyStepVerdict({
    goal: goal(),
    step: running,
    verdict: "pass",
    activeMs: 600_001,
  });
  assert.equal(aborted.kind, "abort");
  assert.equal(aborted.abortRun, true);
  assert.equal(aborted.goalStatus, "blocked");
  assert.equal(aborted.stepStatus, "blocked");
  assert.match(aborted.reason, /active_ms/);

  const under = applyStepVerdict({
    goal: goal(),
    step: running,
    verdict: "pass",
    activeMs: 600_000,
  });
  assert.notEqual(under.kind, "abort");
});

check("invalid verdicts fail closed and budget warnings ride the transition", () => {
  const invalid = applyStepVerdict({
    goal: goal(),
    step: step({ status: "running" }),
    verdict: "maybe",
  });
  assert.equal(invalid.kind, "blocked");
  assert.equal(invalid.reason, "invalid_verdict");

  const budget = { ...DEFAULT_BUDGET, max_steps: 10 };
  const first = step({ id: "s1", seq: 1, status: "running" });
  const second = step({ id: "s2", seq: 2, status: "queued" });
  const warned = applyStepVerdict({
    goal: goal(),
    step: first,
    steps: [first, second],
    verdict: "pass",
    budget,
    previousUsage: usage({ steps: 6 }),
    usage: usage({ steps: 7 }),
  });
  assert.deepEqual(warned.warnings, [70]);

  const high = applyStepVerdict({
    goal: goal(),
    step: first,
    steps: [first, second],
    verdict: "pass",
    budget,
    previousUsage: usage({ steps: 8 }),
    usage: usage({ steps: 9 }),
  });
  assert.deepEqual(high.warnings, [90]);
});

if (failures.length) {
  for (const failure of failures) console.error("  FAIL " + failure);
  process.exit(1);
}
console.log("goal machine: passed");
