// Durable goal orchestration over injected storage, planner, verifier, and
// session client. No SDK imports; the Durable Object wrapper supplies the real
// services.

import { GoalStore } from "./goal-store.ts";
import {
  DEFAULT_BUDGET,
  type Check,
  type GoalBudget,
  type GoalRow,
  type GoalStatus,
  type GoalUsage,
  type StepRow,
  type GoalAttentionKind,
} from "./goal-types.ts";
import {
  addUsage,
  applyStepVerdict,
  budgetLevel,
  nextClaim,
  type ClaimDecision,
} from "./goal-machine.ts";
import { type PlannerInput, type PlanGoalResult } from "./goal-planner.ts";
import { type VerifierInput, type VerifierResult } from "./goal-verifier.ts";
import { buildStepPrompt, type CompletedStepDigest } from "./goal-run.ts";

const MAX_RUNNING = 2;
const LEASE_MS = 15 * 60 * 1000;
/** A verifier call is bounded well under this; past it the verification is lost. */
const VERIFY_STALE_MS = 15 * 60 * 1000;

export interface GoalSessionClient {
  startGoalStep(input: {
    sessionId: string;
    goalId: string;
    stepId: string;
    runId: string;
    leaseToken: string;
    prompt: string;
    checks: Check[];
  }): Promise<{ ok: boolean; error?: string }>;
  abortGoalRun(sessionId: string, runId: string): Promise<{ aborted: boolean; sideEffects: boolean }>;
}

export interface GoalSupervisorDeps {
  store: GoalStore;
  sessions: GoalSessionClient;
  plan(input: PlannerInput): Promise<PlanGoalResult>;
  verify(input: VerifierInput): Promise<VerifierResult>;
  now(): number;
  id(): string;
  maxRunning?: number;
}

export interface CreateGoalInput {
  title: string;
  brief: string;
  success_criteria: string;
  session_id: string;
  origin_session_id?: string | null;
  workspace_source?: string | null;
  budget?: Partial<GoalBudget>;
}

export interface StepCompletionInput {
  runId: string;
  leaseToken: string;
  goalId: string;
  stepId: string;
  status: "done" | "error";
  result: string;
  evidence: unknown;
  usage: unknown;
  tools: unknown[];
}

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function budgetOf(goal: GoalRow): GoalBudget {
  return { ...DEFAULT_BUDGET, ...(parseJson<Partial<GoalBudget>>(goal.budget_json) ?? {}) };
}

function usageOf(goal: GoalRow): GoalUsage {
  return {
    steps: 0,
    tool_calls: 0,
    active_ms: 0,
    tokens: 0,
    model_steps: 0,
    replans: 0,
    ...(parseJson<Partial<GoalUsage>>(goal.usage_json) ?? {}),
  };
}

function checksOf(step: StepRow): Check[] {
  const parsed = parseJson<Check[]>(step.checks_json);
  return Array.isArray(parsed) ? parsed : [];
}

function isLastWorkStep(goal: GoalRow, step: StepRow, steps: StepRow[]): boolean {
  return !steps.some(
    (candidate) =>
      candidate.id !== step.id &&
      candidate.kind === "work" &&
      candidate.plan_version === step.plan_version &&
      candidate.status !== "done" &&
      candidate.status !== "skipped" &&
      candidate.status !== "superseded"
  );
}

export class GoalSupervisor {
  private readonly deps: GoalSupervisorDeps; 
  constructor(deps: GoalSupervisorDeps) {
    this.deps = deps;
  }

  async createGoal(input: CreateGoalInput): Promise<GoalRow> {
    const now = this.deps.now();
    const goal = this.deps.store.create(
      {
        title: input.title,
        brief: input.brief,
        success_criteria: input.success_criteria,
        session_id: input.session_id,
        origin_session_id: input.origin_session_id ?? null,
        workspace_source: input.workspace_source ?? null,
        budget: input.budget,
      },
      now,
      this.deps.id()
    );
    this.event(goal.id, null, null, "created", "system", {
      title: goal.title,
      session_id: goal.session_id,
    });
    return goal;
  }

  async tick(now = this.deps.now()): Promise<{ nextWakeAt: number | null }> {
    const paused = this.deps.store.meta("paused") === "1";
    const planning = this.deps.store.list(["planning"], 100);
    for (const goal of planning) {
      await this.planGoalStep(goal, now);
    }
    // Re-read: a newly planned goal is active now and may be claimed in this
    // same tick. The earlier snapshot is intentionally discarded.
    const goals = this.deps.store.list(["active", "waiting", "verifying"], 100);
    for (const goal of goals) {
      if (goal.status === "verifying") {
        // completeStep sets this while its verifier call is in flight. Blocking
        // here would race that call and mark a goal failed mid-verification. A
        // verification older than the stale window is lost, not in flight.
        const verifyingStep = this.deps.store
          .steps(goal.id)
          .find((step) => step.status === "verifying");
        if (
          verifyingStep &&
          now - (verifyingStep.updated_at ?? verifyingStep.finished_at ?? 0) >
            VERIFY_STALE_MS
        ) {
          this.deps.store.updateStep(verifyingStep.id, {
            status: "queued",
            attempts: verifyingStep.attempts + 1,
            updated_at: now,
          });
          this.deps.store.update(goal.id, {
            status: "active",
            last_error: null,
            updated_at: now,
          });
          this.event(goal.id, verifyingStep.id, null, "retry", "system", {
            reason: "verification_stale",
          });
        }
        continue;
      }
      const steps = this.deps.store.steps(goal.id);
      // A stale lease is a failed run. The state machine decides retry vs block.
      for (const step of steps) {
        if (
          step.status === "running" &&
          step.lease_until !== null &&
          step.lease_until < now
        ) {
          this.deps.store.updateStep(step.id, {
            status: "failed",
            last_error: "lease_expired",
            lease_token: null,
            lease_until: null,
            updated_at: now,
          });
          this.event(goal.id, step.id, null, "step_finished", "system", {
            reason: "lease_expired",
          });
          const fresh = this.deps.store.get(goal.id) ?? goal;
          this.block(fresh, step, "lease_expired", "blocked");
        }
      }
      const refreshed = this.deps.store.get(goal.id);
      if (!refreshed || refreshed.status === "blocked" || refreshed.status === "done") continue;
      const freshSteps = this.deps.store.steps(goal.id);
      const usage = usageOf(refreshed);
      const budget = budgetOf(refreshed);
      if (budgetLevel(budget, usage) === "exhausted") {
        this.block(refreshed, null, "budget_exhausted", "budget_exhausted");
        continue;
      }
      const decision = nextClaim({
        goal: refreshed,
        steps: freshSteps,
        now,
        paused: paused || refreshed.paused === 1,
        runningCount: this.runningCount(),
        maxRunning: this.deps.maxRunning ?? MAX_RUNNING,
        budget,
        usage,
      });
      await this.handleClaim(refreshed, decision, now);
    }
    return { nextWakeAt: this.nextWake(now, paused) };
  }

  async completeStep(input: StepCompletionInput): Promise<void> {
    const goal = this.deps.store.get(input.goalId);
    const step = this.deps.store.getStep(input.stepId);
    const run = this.deps.store.getRun(input.runId);
    if (!goal || !step || !run) return;
    if (run.status !== "running" && run.status !== "stale") return;
    if (step.lease_token !== input.leaseToken) {
      this.event(goal.id, step.id, input.runId, "step_finished", "system", {
        reason: "lease_mismatch",
      });
      return;
    }
    const now = this.deps.now();
    this.deps.store.updateRun(run.id, {
      status: input.status === "done" ? "done" : "failed",
      result: input.result,
      result_json: input.result,
      usage: input.usage as Partial<GoalUsage>,
      error: input.status === "done" ? null : input.result.slice(0, 2000),
      finished_at: now,
    });
    this.deps.store.updateStep(step.id, {
      status: "verifying",
      evidence: input.evidence,
      result: input.result,
      lease_token: null,
      lease_until: null,
      finished_at: now,
      updated_at: now,
    });
    this.event(goal.id, step.id, run.id, "step_finished", "system", {
      status: input.status,
      tools: input.tools,
    });

    if (input.status === "error") {
      const verdict: VerifierResult = {
        verdict: "retry",
        reason: "the step turn failed",
        feedback: "Retry the step without repeating side effects.",
        evidence_used: [],
        goal_done: false,
      };
      await this.applyVerdict(goal, step, run.id, verdict, input, now);
      return;
    }

    const verifier = await this.deps.verify({
      goal: {
        title: goal.title,
        brief: goal.brief,
        success_criteria: goal.success_criteria,
      },
      step: {
        title: step.title,
        objective: step.objective,
        done_when: step.done_when,
        checks: checksOf(step),
        seq: step.seq,
      },
      checks: checksOf(step),
      evidence: input.evidence as VerifierInput["evidence"],
      report: input.result,
      is_last: isLastWorkStep(goal, step, this.deps.store.steps(goal.id)),
      can_replan: usageOf(goal).replans < budgetOf(goal).max_replans,
    });
    await this.applyVerdict(goal, step, run.id, verifier, input, now);
  }

  async approvalPending(input: { runId: string; goalId: string; stepId: string }): Promise<void> {
    const goal = this.deps.store.get(input.goalId);
    if (!goal) return;
    this.event(goal.id, input.stepId, input.runId, "approval_requested", "system", {});
    this.block(goal, this.deps.store.getStep(input.stepId), "approval_required", "approval");
  }

  async control(
    id: string,
    action: "pause" | "resume" | "cancel" | "retry" | "instruct" | "budget",
    note?: string
  ): Promise<{ ok: boolean; error?: string }> {
    const goal = this.deps.store.get(id);
    if (!goal) return { ok: false, error: "not found" };
    const now = this.deps.now();
    if (action === "pause" || action === "resume") {
      const paused = action === "pause" ? 1 : 0;
      this.deps.store.update(id, { paused, updated_at: now });
      this.event(id, null, null, action === "pause" ? "paused" : "resumed", "user", {});
      return { ok: true };
    }
    if (action === "instruct") {
      const content = String(note ?? "").trim();
      if (!content) return { ok: false, error: "instruction required" };
      this.deps.store.addInstruction(id, content.slice(0, 8000), now);
      this.event(id, null, null, "instruction_added", "user", { content });
      return { ok: true };
    }
    if (action === "cancel") {
      const step = goal.current_step_id ? this.deps.store.getStep(goal.current_step_id) : null;
      if (step?.status === "running") {
        const run = this.deps.store.listEvents(id, null, 1)[0];
        if (run) await this.deps.sessions.abortGoalRun(goal.session_id, String(run.run_id ?? ""));
        this.deps.store.updateStep(step.id, { status: "failed", updated_at: now });
      }
      this.deps.store.update(id, {
        status: "cancelled",
        finished_at: now,
        last_error: note ?? null,
        updated_at: now,
      });
      this.event(id, step?.id ?? null, null, "cancelled", "user", { note });
      return { ok: true };
    }
    if (action === "retry") {
      const step = goal.current_step_id ? this.deps.store.getStep(goal.current_step_id) : null;
      if (!step) return { ok: false, error: "no step to retry" };
      this.deps.store.updateStep(step.id, {
        status: "queued",
        attempts: Math.max(0, step.attempts - 1),
        last_error: null,
        updated_at: now,
      });
      this.deps.store.update(id, { status: "active", last_error: null, updated_at: now });
      this.event(id, step.id, null, "retry", "user", { note });
      return { ok: true };
    }
    if (action === "budget") {
      const parsed = parseJson<Partial<GoalBudget>>(note ?? "{}");
      if (!parsed) return { ok: false, error: "budget JSON is invalid" };
      this.deps.store.update(id, { budget: parsed, updated_at: now });
      this.event(id, null, null, "resumed", "user", { budget: parsed });
      return { ok: true };
    }
    return { ok: false, error: "unknown action" };
  }

  get(id: string): GoalRow | null {
    return this.deps.store.get(id);
  }

  list(statuses?: GoalStatus[], limit = 100): GoalRow[] {
    return this.deps.store.list(statuses ?? null, limit);
  }

  events(id: string, after: number | null, limit = 100) {
    return this.deps.store.listEvents(id, after, limit);
  }

  attention(limit = 50) {
    return this.deps.store.listAttention(limit);
  }

  private async planGoalStep(goal: GoalRow, now: number): Promise<void> {
    const budget = budgetOf(goal);
    const result = await this.deps.plan({
      title: goal.title,
      brief: goal.brief,
      success_criteria: goal.success_criteria,
      budget: budget as unknown as Record<string, unknown>,
      now,
    });
    const steps = result.steps;
    const version = Math.max(1, goal.plan_version + 1);
    this.deps.store.addPlan(goal.id, version, JSON.stringify(steps), "initial", now);
    this.deps.store.addSteps(goal.id, version, steps, now);
    this.deps.store.update(goal.id, {
      status: "active",
      plan_version: version,
      last_error: result.error ?? null,
      updated_at: now,
    });
    this.event(goal.id, null, null, "planned", "agent", {
      version,
      steps: steps.length,
      fallback: result.usedFallback,
    });
  }

  private async handleClaim(goal: GoalRow, decision: ClaimDecision, now: number): Promise<void> {
    if (decision.kind === "wait" && decision.wakeAt) {
      this.deps.store.update(goal.id, { status: "waiting", updated_at: now });
      return;
    }
    if (decision.kind === "verify" || decision.kind === "done") {
      if (decision.kind === "done") {
        this.deps.store.update(goal.id, {
          status: "done",
          finished_at: now,
          last_error: null,
          summary: goal.summary ?? "The plan is complete.",
          updated_at: now,
        });
        this.event(goal.id, null, null, "completed", "system", {});
      }
      // A `verify` decision means a step verification is already in flight or a
      // last-step verdict is about to land. Waiting is the only safe move.
      return;
    }
    if (decision.kind !== "claim" || !decision.step) return;
    const step = decision.step;
    if (step.kind === "wait") {
      this.deps.store.updateStep(step.id, {
        status: "done",
        finished_at: now,
        updated_at: now,
      });
      this.deps.store.update(goal.id, { status: "active", updated_at: now });
      this.event(goal.id, step.id, null, "step_finished", "system", { wait: true });
      return;
    }
    const token = `${this.deps.id()}.${now.toString(36)}`;
    const claimed = this.deps.store.claimStep(goal.id, now, LEASE_MS, token);
    if (!claimed) return;
    const runId = this.deps.id();
    this.deps.store.insertRun({
      id: runId,
      goal_id: goal.id,
      step_id: claimed.id,
      session_id: goal.session_id,
      status: "running",
      usage_json: null,
      result_json: null,
      error: null,
      started_at: now,
      finished_at: null,
    });
    this.deps.store.update(goal.id, {
      status: "active",
      current_step_id: claimed.id,
      updated_at: now,
    });
    this.event(goal.id, claimed.id, runId, "step_started", "system", {});
    const instructions = this.deps.store.instructions(goal.id).map((item) => item.content);
    const completed: CompletedStepDigest[] = this.deps.store
      .steps(goal.id)
      .filter((candidate) => candidate.status === "done" && candidate.id !== claimed.id)
      .map((candidate) => ({
        title: candidate.title,
        result: candidate.result_json ?? "",
      }));
    const prompt = buildStepPrompt({
      goal: {
        title: goal.title,
        brief: goal.brief,
        success_criteria: goal.success_criteria,
      },
      step: {
        title: claimed.title,
        objective: claimed.objective,
        done_when: claimed.done_when,
        checks: checksOf(claimed),
      },
      checks: checksOf(claimed),
      completed,
      instructions,
      remaining_budget: budgetOf(goal) as unknown as Record<string, unknown>,
      usage: usageOf(goal) as unknown as Record<string, unknown>,
      attempt: claimed.attempts + 1,
      step_index: claimed.seq,
      step_count: this.deps.store.steps(goal.id).filter((s) => s.kind === "work").length,
    });
    const result = await this.deps.sessions.startGoalStep({
      sessionId: goal.session_id,
      goalId: goal.id,
      stepId: claimed.id,
      runId,
      leaseToken: token,
      prompt,
      checks: checksOf(claimed),
    });
    if (!result.ok) {
      this.deps.store.updateStep(claimed.id, {
        status: "failed",
        last_error: result.error?.slice(0, 2000) ?? "session refused the step",
        lease_token: null,
        lease_until: null,
        updated_at: now,
      });
      this.deps.store.updateRun(runId, {
        status: "failed",
        error: result.error ?? "session refused the step",
        finished_at: now,
      });
      this.block(goal, claimed, result.error ?? "session_refused", "blocked");
    }
  }

  private async applyVerdict(
    goal: GoalRow,
    step: StepRow,
    runId: string,
    verifier: VerifierResult,
    completion: StepCompletionInput,
    now: number
  ): Promise<void> {
    const steps = this.deps.store.steps(goal.id);
    const usageBefore = usageOf(goal);
    const tokens =
      typeof (completion.usage as { tokens?: unknown })?.tokens === "number"
        ? ((completion.usage as { tokens: number }).tokens ?? 0)
        : 0;
    const usageAfter = addUsage(usageBefore, {
      steps: 1,
      tool_calls: Array.isArray(completion.tools) ? completion.tools.length : 0,
      active_ms: 0,
      tokens,
      model_steps: 1,
      replans: 0,
    });
    this.deps.store.update(goal.id, {
      usage: usageAfter,
      updated_at: now,
    });
    const transition = applyStepVerdict({
      goal,
      step,
      steps,
      verdict: verifier.verdict,
      reason: verifier.reason,
      feedback: verifier.feedback,
      goalDone: verifier.goal_done,
      runId,
      ledger: Array.isArray(completion.tools) ? (completion.tools as never[]) : [],
      budget: budgetOf(goal),
      usage: usageAfter,
      previousUsage: usageBefore,
      maxActiveMs: 10 * 60 * 1000,
    });
    this.event(goal.id, step.id, runId, "verified", "verifier", {
      verdict: verifier.verdict,
      reason: verifier.reason,
      goal_done: verifier.goal_done,
    });
    this.applyTransition(goal, step, transition, now);
  }

  private applyTransition(
    goal: GoalRow,
    step: StepRow | null,
    transition: ReturnType<typeof applyStepVerdict>,
    now: number
  ): void {
    if (transition.kind === "ignore") return;
    if (transition.kind === "abort") {
      if (step) this.deps.store.updateStep(step.id, { status: "blocked", updated_at: now });
      this.deps.store.update(goal.id, { status: "blocked", last_error: transition.reason ?? null, updated_at: now });
      this.raiseAttention(goal, transition.attentionKind ?? "blocked", transition.reason ?? "blocked");
      return;
    }
    if (transition.kind === "blocked") {
      if (step) {
        this.deps.store.updateStep(step.id, {
          status: transition.stepStatus ?? "blocked",
          last_error: transition.reason ?? null,
          updated_at: now,
        });
      }
      this.deps.store.update(goal.id, {
        status: "blocked",
        last_error: transition.reason ?? null,
        updated_at: now,
      });
      this.raiseAttention(goal, transition.attentionKind ?? "blocked", transition.reason ?? "blocked");
      return;
    }
    if (transition.kind === "done") {
      if (step) this.deps.store.updateStep(step.id, { status: "done", updated_at: now });
      this.deps.store.update(goal.id, {
        status: "done",
        finished_at: now,
        last_error: null,
        summary: "The verifier confirmed the goal.",
        updated_at: now,
      });
      this.event(goal.id, step?.id ?? null, null, "completed", "verifier", {});
      this.raiseAttention(goal, "done", "Goal completed");
      return;
    }
    if (transition.kind === "retry") {
      if (step) {
        this.deps.store.updateStep(step.id, {
          status: "queued",
          attempts: step.attempts + 1,
          last_error: null,
          updated_at: now,
        });
      }
      this.deps.store.update(goal.id, { status: "active", updated_at: now });
      this.event(goal.id, step?.id ?? null, null, "retry", "verifier", {
        reason: transition.reason ?? null,
      });
      return;
    }
    if (transition.kind === "verify") {
      this.deps.store.update(goal.id, { status: "verifying", updated_at: now });
      return;
    }
    if (transition.kind === "advance" || transition.kind === "replan") {
      if (step) {
        if (transition.kind === "advance") {
          this.deps.store.updateStep(step.id, { status: "done", updated_at: now });
        }
      }
      for (const id of transition.supersededStepIds ?? []) {
        this.deps.store.updateStep(id, { status: "superseded", updated_at: now });
      }
      this.deps.store.update(goal.id, {
        status: transition.kind === "replan" ? "planning" : (transition.goalStatus ?? "active"),
        plan_version: transition.version ?? goal.plan_version,
        current_step_id: transition.nextStepId ?? null,
        updated_at: now,
      });
      this.event(goal.id, step?.id ?? null, null, transition.kind === "replan" ? "replanned" : "step_finished", "verifier", {
        reason: transition.reason ?? null,
      });
    }
  }

  private block(goal: GoalRow, step: StepRow | null, reason: string, kind: GoalAttentionKind): void {
    const now = this.deps.now();
    if (step) this.deps.store.updateStep(step.id, { status: "blocked", last_error: reason, updated_at: now });
    this.deps.store.update(goal.id, { status: "blocked", last_error: reason, updated_at: now });
    this.raiseAttention(goal, kind, reason);
  }

  private raiseAttention(goal: GoalRow, kind: GoalAttentionKind, reason: string): void {
    this.deps.store.addAttention({
      goal_id: goal.id,
      kind,
      title: goal.title,
      body: reason,
      created_at: this.deps.now(),
    });
  }

  private event(
    goalId: string,
    stepId: string | null,
    runId: string | null,
    type: Parameters<GoalStore["addEvent"]>[0]["type"],
    actor: "system" | "agent" | "user" | "verifier",
    payload: unknown
  ): void {
    this.deps.store.addEvent({
      goal_id: goalId,
      step_id: stepId,
      run_id: runId,
      type,
      actor,
      payload,
      created_at: this.deps.now(),
    });
  }

  private runningCount(): number {
    let count = 0;
    for (const goal of this.deps.store.list(["active", "waiting", "verifying"], 100)) {
      count += this.deps.store.steps(goal.id).filter((step) => step.status === "running").length;
    }
    return count;
  }

  private nextWake(now: number, paused: boolean): number | null {
    if (paused) return null;
    let next: number | null = null;
    for (const goal of this.deps.store.list(["waiting", "active"], 100)) {
      for (const step of this.deps.store.steps(goal.id)) {
        if (step.status === "queued" && step.wake_at && step.wake_at > now) {
          if (next === null || step.wake_at < next) next = step.wake_at;
        }
        if (step.status === "running" && step.lease_until) {
          if (next === null || step.lease_until < next) next = step.lease_until;
        }
      }
    }
    return next;
  }
}
