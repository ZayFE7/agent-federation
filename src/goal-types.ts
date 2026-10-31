// Shared, dependency-free shapes for durable goals. No runtime imports so plain
// Node tests can import this directly through type stripping, matching
// automation-types.ts. All dates are epoch milliseconds and all ids are opaque
// strings. JSON columns stay serialized in the row types; the store caps them.

export type GoalStatus =
  | "planning"
  | "active"
  | "waiting"
  | "verifying"
  | "blocked"
  | "done"
  | "cancelled"
  | "failed";

export type StepStatus =
  | "queued"
  | "running"
  | "verifying"
  | "done"
  | "failed"
  | "blocked"
  | "skipped"
  | "superseded";

export type StepKind = "work" | "wait";

/** Structured checks are evaluated against trusted evidence, not model prose. */
export interface FileCheck {
  type: "file";
  path: string;
  min_bytes?: number;
  max_bytes?: number;
  sha256?: string;
}

export interface ArtifactCheck {
  type: "artifact";
  path: string;
}

export interface ToolExitCheck {
  type: "tool_exit";
  tool: string;
  /** Expected exit code; defaults to 0 when omitted. */
  code?: number;
}

export interface TextCheck {
  type: "text";
  criterion: string;
}

export interface ForbiddenEffectCheck {
  type: "forbidden_effect";
  tool?: string;
  path?: string;
  description?: string;
}

export type Check =
  | FileCheck
  | ArtifactCheck
  | ToolExitCheck
  | TextCheck
  | ForbiddenEffectCheck;

/** One planner step. `checks` are stored capped in checks_json. */
export interface PlanStep {
  kind: StepKind;
  title: string;
  objective: string;
  done_when: string;
  checks: Check[];
  suggested_tools?: string[];
  risky?: boolean;
  max_attempts?: number;
  wake_at?: number;
  wait_minutes?: number;
}

export interface GoalBudget {
  max_steps: number;
  max_tool_calls: number;
  max_active_ms: number;
  max_tokens: number;
  max_attempts_per_step: number;
  max_replans: number;
  max_wait_ms: number;
}

export interface GoalUsage {
  steps: number;
  tool_calls: number;
  active_ms: number;
  tokens: number;
  model_steps: number;
  replans: number;
}

export interface GoalRow {
  id: string;
  session_id: string;
  origin_session_id: string | null;
  workspace_source: string | null;
  title: string;
  brief: string;
  success_criteria: string;
  status: GoalStatus;
  paused: number;
  plan_version: number;
  budget_json: string;
  usage_json: string;
  current_step_id: string | null;
  summary: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface StepRow {
  id: string;
  goal_id: string;
  plan_version: number;
  seq: number;
  kind: StepKind;
  title: string;
  objective: string;
  done_when: string;
  checks_json: string | null;
  status: StepStatus;
  attempts: number;
  max_attempts: number;
  wake_at: number | null;
  lease_token: string | null;
  lease_until: number | null;
  evidence_json: string | null;
  result_json: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface GoalPlanRow {
  id: string;
  goal_id: string;
  version: number;
  plan_json: string;
  reason: string | null;
  created_at: number;
}

export type GoalRunStatus = "running" | "done" | "failed" | "aborted" | "stale";

export interface GoalRunRow {
  id: string;
  goal_id: string;
  step_id: string;
  session_id: string;
  status: GoalRunStatus;
  usage_json: string | null;
  result_json: string | null;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
}

export type GoalEventType =
  | "created"
  | "planned"
  | "step_queued"
  | "step_started"
  | "step_accepted"
  | "tool_called"
  | "step_finished"
  | "evidence_collected"
  | "verified"
  | "retry"
  | "replanned"
  | "paused"
  | "resumed"
  | "budget_warning"
  | "budget_exhausted"
  | "approval_requested"
  | "approved"
  | "denied"
  | "completed"
  | "failed"
  | "cancelled"
  | "instruction_added"
  | "superseded"
  | "session_deleted";

export type GoalActor = "system" | "agent" | "user" | "verifier";

export interface GoalEventRow {
  id: number;
  goal_id: string;
  step_id: string | null;
  run_id: string | null;
  type: GoalEventType;
  actor: GoalActor;
  payload_json: string | null;
  created_at: number;
}

export type GoalAttentionKind =
  | "done"
  | "failed"
  | "blocked"
  | "budget_exhausted"
  | "approval";

export interface GoalAttentionRow {
  id: number;
  goal_id: string;
  kind: GoalAttentionKind;
  title: string;
  body: string | null;
  read: number;
  created_at: number;
}

export interface GoalInstructionRow {
  id: number;
  goal_id: string;
  content: string;
  created_at: number;
}

/** The coordinator's compact copy of one session tool-ledger row. */
export interface ToolLedgerSummary {
  tool: string;
  input_hash: string;
  side_effect: number | boolean;
  status: "intent" | "finished" | "failed";
}

/** The coordinator's audit copy of a session tool call. */
export interface GoalToolCallRow {
  id: number;
  goal_id: string;
  step_id: string | null;
  run_id: string | null;
  tool: string;
  input_hash: string | null;
  side_effect: number;
  result_json: string | null;
  created_at: number;
}

export interface NewGoalInput {
  title: string;
  brief: string;
  success_criteria: string;
  /** Dedicated goal session. One non-terminal goal is allowed per session. */
  session_id: string;
  origin_session_id?: string | null;
  workspace_source?: string | null;
  budget?: Partial<GoalBudget>;
}

/** Defaults from the design: 30 steps, 150 calls, 6 h, 2M tokens, 2/2, 7 d. */
export const DEFAULT_BUDGET: GoalBudget = {
  max_steps: 30,
  max_tool_calls: 150,
  max_active_ms: 6 * 60 * 60 * 1000,
  max_tokens: 2_000_000,
  max_attempts_per_step: 2,
  max_replans: 2,
  max_wait_ms: 7 * 24 * 60 * 60 * 1000,
};

export const TERMINAL_GOAL_STATUSES: readonly GoalStatus[] = [
  "done",
  "cancelled",
  "failed",
];

/** Statuses that will never be claimed again without an explicit requeue. */
export const TERMINAL_STEP_STATUSES: readonly StepStatus[] = [
  "done",
  "failed",
  "blocked",
  "skipped",
  "superseded",
];

/** Payload caps from the design; the store slices serialized UTF-8 text. */
export const GOAL_PAYLOAD_LIMITS = {
  briefBytes: 16 * 1024,
  successCriteriaBytes: 8 * 1024,
  objectiveBytes: 8 * 1024,
  checksBytes: 16 * 1024,
  evidenceBytes: 32 * 1024,
  eventBytes: 16 * 1024,
  instructionBytes: 8 * 1024,
  planBytes: 64 * 1024,
  resultBytes: 32 * 1024,
  toolResultBytes: 16 * 1024,
} as const;
