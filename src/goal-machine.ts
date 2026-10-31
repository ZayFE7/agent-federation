// Pure goal decisions: budgets, claims, retries, replans, and verdict
// transitions. No store writes and no runtime imports except the shared types.
// The supervisor applies the returned transitions; this module never reads a
// clock, a database, or a session.

import type {
  GoalAttentionKind,
  GoalBudget,
  GoalRow,
  GoalStatus,
  GoalUsage,
  StepRow,
  StepStatus,
  ToolLedgerSummary,
} from "./goal-types.ts";

export type StepVerdict = "pass" | "retry" | "replan" | "blocked" | "done";
export type GoalTransitionKind =
  | "ignore"
  | "advance"
  | "retry"
  | "replan"
  | "blocked"
  | "done"
  | "verify"
  | "abort";

/** Per-step hard limits for one harness turn chain, from the design. */
export interface StepLimits {
  max_model_steps: number;
  max_tool_calls: number;
  max_active_ms: number;
}

export const DEFAULT_STEP_LIMITS: StepLimits = {
  max_model_steps: 12,
  max_tool_calls: 20,
  max_active_ms: 10 * 60 * 1000,
};

export type BudgetLevel = "ok" | "warn" | "exhausted";
export type BudgetWarning = 70 | 90;

const WARN_RATIO = 0.7;
const HIGH_WARN_RATIO = 0.9;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_MAX_REPLANS = 2;

// Kept local so this module stays a types-only import; these mirror
// TERMINAL_GOAL_STATUSES and TERMINAL_STEP_STATUSES from goal-types.ts.
const TERMINAL_GOALS: readonly GoalStatus[] = ["done", "cancelled", "failed"];
const FINISHED_STEPS: readonly StepStatus[] = ["done", "skipped", "superseded"];

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function ratio(limit: unknown, used: unknown): number {
  const max = numberOrZero(limit);
  if (max <= 0) return 0;
  return numberOrZero(used) / max;
}

/** Highest consumption ratio across the four aggregate budgets. */
export function budgetRatio(
  budget: GoalBudget,
  usage: Partial<GoalUsage> | null | undefined
): number {
  const used = usage ?? {};
  return Math.max(
    ratio(budget.max_steps, used.steps),
    ratio(budget.max_tool_calls, used.tool_calls),
    ratio(budget.max_active_ms, used.active_ms),
    ratio(budget.max_tokens, used.tokens)
  );
}

/** 70 at the first warning, 90 at the second, null below 70. */
export function budgetWarningLevel(
  budget: GoalBudget,
  usage: Partial<GoalUsage> | null | undefined
): BudgetWarning | null {
  const value = budgetRatio(budget, usage);
  if (value >= HIGH_WARN_RATIO) return 90;
  if (value >= WARN_RATIO) return 70;
  return null;
}

/** "ok" below 70%, "warn" at 70-99%, "exhausted" at 100%. */
export function budgetLevel(
  budget: GoalBudget,
  usage: Partial<GoalUsage> | null | undefined
): BudgetLevel {
  const value = budgetRatio(budget, usage);
  if (value >= 1) return "exhausted";
  if (value >= WARN_RATIO) return "warn";
  return "ok";
}

/**
 * Thresholds crossed between two usage snapshots. A jump emits both the 70 and
 * 90 warnings once, so the supervisor writes at most one event per threshold.
 */
export function budgetWarningsCrossed(
  budget: GoalBudget,
  before: Partial<GoalUsage> | null | undefined,
  after: Partial<GoalUsage> | null | undefined
): BudgetWarning[] {
  const previous = budgetRatio(budget, before);
  const next = budgetRatio(budget, after);
  const warnings: BudgetWarning[] = [];
  if (previous < WARN_RATIO && next >= WARN_RATIO) warnings.push(70);
  if (previous < HIGH_WARN_RATIO && next >= HIGH_WARN_RATIO) warnings.push(90);
  return warnings;
}

/**
 * Per-step usage. Waiting and approval time are explicit non-budgets: they are
 * tracked on the run but never count against active_ms.
 */
export interface StepUsage {
  model_steps?: number;
  tool_calls?: number;
  active_ms?: number;
  wait_ms?: number;
  approval_ms?: number;
}

export function stepBudgetExceeded(
  usage: StepUsage,
  limits: Partial<StepLimits> = {}
): string | null {
  const max = { ...DEFAULT_STEP_LIMITS, ...limits };
  const modelSteps = numberOrZero(usage.model_steps);
  const toolCalls = numberOrZero(usage.tool_calls);
  const activeMs = numberOrZero(usage.active_ms);
  if (modelSteps > max.max_model_steps) {
    return `model_steps ${modelSteps} exceeds ${max.max_model_steps}`;
  }
  if (toolCalls > max.max_tool_calls) {
    return `tool_calls ${toolCalls} exceeds ${max.max_tool_calls}`;
  }
  if (activeMs > max.max_active_ms) {
    return `active_ms ${activeMs} exceeds ${max.max_active_ms}`;
  }
  return null;
}

export interface RetryDecisionInput {
  ledger?: readonly ToolLedgerSummary[];
  attempts: number;
  maxAttempts?: number;
}

/**
 * Read-only finished calls may be retried. A side effect in any state, or an
 * intent without a finish, forbids an automatic retry: the crash may have
 * happened after the external write.
 */
export function canAutoRetry(input: RetryDecisionInput): boolean {
  const attempts = numberOrZero(input.attempts);
  const maxAttempts = numberOrZero(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  if (attempts >= maxAttempts) return false;
  for (const call of input.ledger ?? []) {
    if (call.status === "intent") return false;
    if (call.side_effect) return false;
  }
  return true;
}

export type ClaimDecisionKind = "claim" | "wait" | "idle" | "blocked" | "verify" | "done";

export interface ClaimDecision {
  kind: ClaimDecisionKind;
  step?: StepRow;
  wakeAt?: number;
  reason?: string;
}

export interface NextClaimInput {
  goal: GoalRow;
  steps: StepRow[];
  now: number;
  /** Effective pause: global pause OR goal.paused. */
  paused: boolean;
  runningCount: number;
  maxRunning: number;
  budget?: GoalBudget;
  usage?: Partial<GoalUsage> | null;
}

function currentPlanSteps(goal: GoalRow, steps: readonly StepRow[]): StepRow[] {
  let version = numberOrZero(goal.plan_version);
  for (const step of steps) {
    if (step.plan_version > version) version = step.plan_version;
  }
  return steps.filter(
    (step) => step.plan_version === version && step.status !== "superseded"
  );
}

function sortedQueued(steps: readonly StepRow[]): StepRow[] {
  return steps
    .filter((step) => step.status === "queued")
    .slice()
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}

/** First work step not in a finished step status. */
export function countWorkSteps(steps: readonly StepRow[]): number {
  return steps.filter(
    (step) => step.kind === "work" && step.status !== "superseded" && step.status !== "skipped"
  ).length;
}

function allWorkDone(steps: readonly StepRow[]): boolean {
  const work = steps.filter(
    (step) => step.kind === "work" && step.status !== "superseded" && step.status !== "skipped"
  );
  return work.every((step) => step.status === "done");
}

/**
 * Decide what the supervisor should do next for one goal. One step per goal is
 * enforced here (a running or verifying step means no claim), as is the global
 * running cap. Terminal goals and all-done plans return done; an empty plan or
 * no queued step with work left returns verify.
 */
export function nextClaim(input: NextClaimInput): ClaimDecision {
  const { goal, steps } = input;

  if (TERMINAL_GOALS.includes(goal.status)) {
    return { kind: "done", reason: `goal_${goal.status}` };
  }
  if (input.paused || goal.paused === 1) {
    return { kind: "idle", reason: "paused" };
  }
  if (goal.status === "blocked") {
    return { kind: "blocked", reason: goal.last_error ?? "goal_blocked" };
  }
  if (goal.status === "planning") {
    return { kind: "idle", reason: "planning" };
  }
  if (goal.status === "verifying") {
    return { kind: "verify", reason: "goal_verifying" };
  }
  if (
    input.budget &&
    input.usage &&
    budgetLevel(input.budget, input.usage) === "exhausted"
  ) {
    return { kind: "blocked", reason: "budget_exhausted" };
  }

  const current = currentPlanSteps(goal, steps);

  const running = current.find((step) => step.status === "running");
  if (running) return { kind: "idle", reason: "step_running", step: running };

  const verifying = current.find((step) => step.status === "verifying");
  if (verifying) return { kind: "verify", reason: "step_verifying", step: verifying };

  const stuck = current.find(
    (step) => step.status === "blocked" || step.status === "failed"
  );
  if (stuck) return { kind: "blocked", reason: `step_${stuck.status}`, step: stuck };

  const queued = sortedQueued(current);
  const next = queued[0];
  if (next) {
    if (next.kind === "wait") {
      if (next.wake_at !== null && next.wake_at !== undefined && next.wake_at > input.now) {
        return { kind: "wait", step: next, wakeAt: next.wake_at };
      }
      // The wait elapsed: hand it back so the supervisor can close the step.
      return { kind: "claim", step: next, reason: "wait_elapsed" };
    }
    const runningCount = numberOrZero(input.runningCount);
    const maxRunning = numberOrZero(input.maxRunning);
    if (runningCount >= maxRunning) {
      return { kind: "idle", reason: "running_cap", step: next };
    }
    return { kind: "claim", step: next };
  }

  const work = current.filter(
    (step) => step.kind === "work" && step.status !== "superseded" && step.status !== "skipped"
  );
  if (work.length === 0) return { kind: "verify", reason: "no_steps" };
  if (work.every((step) => step.status === "done")) {
    return { kind: "done", reason: "all_steps_done" };
  }
  return { kind: "verify", reason: "no_queued_steps" };
}

export interface GoalTransition {
  kind: GoalTransitionKind;
  goalStatus?: GoalStatus;
  stepStatus?: StepStatus;
  stepId?: string;
  nextStepId?: string | null;
  waitAt?: number | null;
  attempts?: number;
  version?: number;
  supersededStepIds?: string[];
  reason?: string;
  feedback?: string | null;
  abortRun?: boolean;
  attentionKind?: GoalAttentionKind;
  warnings?: BudgetWarning[];
}

export interface StepVerdictInput {
  goal: GoalRow;
  step: StepRow;
  /** All steps known for the goal; the current step is added when absent. */
  steps?: readonly StepRow[];
  verdict: StepVerdict | string;
  reason?: string;
  feedback?: string | null;
  goalDone?: boolean;
  goal_done?: boolean;
  runId?: string | null;
  run_id?: string | null;
  appliedRunIds?: readonly string[];
  seenRunIds?: readonly string[];
  lastRunId?: string | null;
  ledger?: readonly ToolLedgerSummary[];
  activeMs?: number;
  maxActiveMs?: number;
  budget?: GoalBudget;
  usage?: Partial<GoalUsage> | null;
  previousUsage?: Partial<GoalUsage> | null;
  replansUsed?: number;
}

const VERDICTS: readonly StepVerdict[] = ["pass", "retry", "replan", "blocked", "done"];

function blockedTransition(
  stepId: string,
  reason: string,
  warnings: BudgetWarning[],
  attentionKind: GoalAttentionKind = "blocked"
): GoalTransition {
  return {
    kind: "blocked",
    goalStatus: "blocked",
    stepStatus: "blocked",
    stepId,
    reason,
    attentionKind,
    warnings,
  };
}

function nextQueuedStep(steps: readonly StepRow[], current: StepRow): StepRow | null {
  const candidates = steps
    .filter(
      (step) =>
        step.id !== current.id &&
        step.plan_version === current.plan_version &&
        step.seq > current.seq &&
        step.status === "queued"
    )
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  return candidates[0] ?? null;
}

function replanOrBlock(
  input: StepVerdictInput,
  steps: readonly StepRow[],
  reason: string,
  warnings: BudgetWarning[]
): GoalTransition {
  const fallbackReplans = Math.max(0, numberOrZero(input.goal.plan_version) - 1);
  const used = numberOrZero(
    input.replansUsed !== undefined
      ? input.replansUsed
      : input.usage?.replans !== undefined
        ? input.usage.replans
        : fallbackReplans
  );
  const maxReplans = numberOrZero(
    input.budget?.max_replans === undefined ? DEFAULT_MAX_REPLANS : input.budget.max_replans
  );
  if (used >= maxReplans) {
    return blockedTransition(
      input.step.id,
      `replan_limit_reached: ${reason}`,
      warnings,
      "budget_exhausted"
    );
  }

  const version =
    Math.max(numberOrZero(input.goal.plan_version), numberOrZero(input.step.plan_version)) + 1;
  const superseded = Array.from(
    new Set(
      steps
        .filter(
          (step) =>
            step.plan_version <= version - 1 && !FINISHED_STEPS.includes(step.status)
        )
        .map((step) => step.id)
    )
  );
  return {
    kind: "replan",
    goalStatus: "planning",
    stepId: input.step.id,
    version,
    supersededStepIds: superseded,
    reason,
    warnings,
  };
}

/**
 * Apply one verifier verdict. Pure: it returns the step and goal changes the
 * supervisor should persist. Duplicate run ids, late completions on terminal
 * goals, and superseded steps are ignored. A pass advances, a retry requeues
 * only when the ledger is side-effect free, a replan versions and supersedes,
 * and a block writes the blocked transition. A last-step pass with
 * goal_done=false replans while budget remains, then blocks.
 */
export function applyStepVerdict(input: StepVerdictInput): GoalTransition {
  const warnings =
    input.budget && input.previousUsage && input.usage
      ? budgetWarningsCrossed(input.budget, input.previousUsage, input.usage)
      : [];

  if (TERMINAL_GOALS.includes(input.goal.status)) {
    return { kind: "ignore", reason: `goal_${input.goal.status}`, warnings };
  }
  if (input.step.status === "superseded") {
    return { kind: "ignore", reason: "step_superseded", warnings };
  }

  const runId = input.runId ?? input.run_id ?? null;
  if (runId) {
    const applied = new Set([...(input.appliedRunIds ?? []), ...(input.seenRunIds ?? [])]);
    if (applied.has(runId) || input.lastRunId === runId) {
      return { kind: "ignore", reason: "duplicate_run", warnings };
    }
  }

  const rawVerdict = String(input.verdict ?? "").toLowerCase();
  if (!VERDICTS.includes(rawVerdict as StepVerdict)) {
    return blockedTransition(input.step.id, "invalid_verdict", warnings);
  }
  const verdict = rawVerdict as StepVerdict;

  if (verdict === "pass" && input.step.status === "done") {
    return { kind: "ignore", reason: "step_already_done", warnings };
  }

  const activeMs = numberOrZero(input.activeMs);
  const maxActiveMs = finiteOr(input.maxActiveMs, DEFAULT_STEP_LIMITS.max_active_ms);
  if (activeMs > maxActiveMs) {
    return {
      kind: "abort",
      goalStatus: "blocked",
      stepStatus: "blocked",
      stepId: input.step.id,
      abortRun: true,
      reason: `active_ms ${activeMs} exceeds ${maxActiveMs}`,
      attentionKind: "blocked",
      warnings,
    };
  }

  const steps = [...(input.steps ?? [])];
  if (!steps.some((step) => step.id === input.step.id)) steps.push(input.step);
  const passed = verdict === "pass" || verdict === "done";
  const effective = steps.map((step) =>
    passed && step.id === input.step.id
      ? { ...step, status: "done" as StepStatus }
      : step
  );
  const allDone = allWorkDone(effective);
  const goalDone = input.goalDone ?? input.goal_done;

  if (verdict === "pass" || verdict === "done") {
    const stuck = effective.find(
      (step) =>
        step.id !== input.step.id &&
        step.plan_version === input.step.plan_version &&
        (step.status === "blocked" || step.status === "failed")
    );
    if (stuck) {
      return blockedTransition(input.step.id, "plan_stalled", warnings);
    }

    // A queued step after this one always wins, including a wait step: the
    // last work step is not the last step when the plan still has a wait.
    const next = verdict === "pass" ? nextQueuedStep(effective, input.step) : null;
    if (next) {
      return {
        kind: "advance",
        goalStatus: next.kind === "wait" ? "waiting" : "active",
        stepStatus: "done",
        stepId: input.step.id,
        nextStepId: next.id,
        waitAt: next.kind === "wait" ? next.wake_at : null,
        warnings,
      };
    }

    if (verdict === "done") {
      const pending = effective.some(
        (step) => step.id !== input.step.id && step.status === "queued"
      );
      if (pending || !allDone) {
        return blockedTransition(
          input.step.id,
          "done_requires_all_work_steps",
          warnings
        );
      }
      return {
        kind: "done",
        goalStatus: "done",
        stepStatus: "done",
        stepId: input.step.id,
        warnings,
      };
    }

    if (!allDone) {
      return blockedTransition(input.step.id, "plan_stalled", warnings);
    }
    if (goalDone === true) {
      return {
        kind: "done",
        goalStatus: "done",
        stepStatus: "done",
        stepId: input.step.id,
        warnings,
      };
    }
    if (goalDone === false) {
      return replanOrBlock(input, effective, "goal_not_done", warnings);
    }
    return {
      kind: "verify",
      goalStatus: "verifying",
      stepStatus: "done",
      stepId: input.step.id,
      warnings,
    };
  }

  if (verdict === "retry") {
    const ledger = input.ledger ?? [];
    const unsafe = ledger.some(
      (call) => call.status === "intent" || Boolean(call.side_effect)
    );
    if (unsafe) {
      return blockedTransition(input.step.id, "side_effect_retry_blocked", warnings);
    }
    const attempts = numberOrZero(input.step.attempts);
    const maxAttempts = numberOrZero(
      input.step.max_attempts === undefined
        ? DEFAULT_MAX_ATTEMPTS
        : input.step.max_attempts
    );
    if (!canAutoRetry({ ledger, attempts, maxAttempts })) {
      return blockedTransition(input.step.id, "retry_limit_reached", warnings);
    }
    return {
      kind: "retry",
      goalStatus: "active",
      stepStatus: "queued",
      stepId: input.step.id,
      attempts,
      reason: input.reason,
      feedback: input.feedback ?? null,
      warnings,
    };
  }

  if (verdict === "replan") {
    return replanOrBlock(input, effective, input.reason ?? "verifier_replan", warnings);
  }

  // blocked
  return blockedTransition(
    input.step.id,
    input.reason ?? "verifier_blocked",
    warnings
  );
}

/** Sum two usage snapshots; missing or non-finite counters contribute zero. */
export function addUsage(
  a: Partial<GoalUsage> | null | undefined,
  b: Partial<GoalUsage> | null | undefined
): GoalUsage {
  const left = a ?? {};
  const right = b ?? {};
  return {
    steps: numberOrZero(left.steps) + numberOrZero(right.steps),
    tool_calls: numberOrZero(left.tool_calls) + numberOrZero(right.tool_calls),
    active_ms: numberOrZero(left.active_ms) + numberOrZero(right.active_ms),
    tokens: numberOrZero(left.tokens) + numberOrZero(right.tokens),
    model_steps: numberOrZero(left.model_steps) + numberOrZero(right.model_steps),
    replans: numberOrZero(left.replans) + numberOrZero(right.replans),
  };
}
