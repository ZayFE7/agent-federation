// Durable goal state over SqlHandle. Every value is a ? binding, every
// statement is schema-local SQL, and nothing here imports the Agents SDK, so
// plain Node tests can drive it with node:sqlite through the same adapter the
// rest of the suite uses.
//
// The store returns raw rows. budget_json and usage_json stay serialized, like
// the other *_json columns, so callers decide when to decode them.

import {
  DEFAULT_BUDGET,
  GOAL_PAYLOAD_LIMITS,
  TERMINAL_GOAL_STATUSES,
  type GoalActor,
  type GoalAttentionKind,
  type GoalAttentionRow,
  type GoalBudget,
  type GoalEventRow,
  type GoalEventType,
  type GoalInstructionRow,
  type GoalPlanRow,
  type GoalRow,
  type GoalRunRow,
  type GoalRunStatus,
  type GoalStatus,
  type GoalToolCallRow,
  type GoalUsage,
  type NewGoalInput,
  type PlanStep,
  type StepRow,
  type StepStatus,
} from "./goal-types.ts";
import type { SqlHandle } from "./memory.ts";

const MAX_TITLE_BYTES = 512;
const MAX_ID_BYTES = 256;
const MAX_ERROR_BYTES = 4 * 1024;
const MAX_SUMMARY_BYTES = 4 * 1024;
const MAX_PLAN_REASON_BYTES = 256;
const MAX_ATTENTION_BODY_BYTES = 8 * 1024;
const MAX_USAGE_BYTES = 8 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** UTF-8 aware cap: never splits a multi-byte code point. */
function capText(value: string | null | undefined, maxBytes: number): string | null {
  if (value === null || value === undefined) return null;
  const bytes = encoder.encode(value);
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return decoder.decode(bytes.subarray(0, end));
}

/** Serialize (unless already a JSON string) and cap before storage. */
function capJson(value: unknown, maxBytes: number): string {
  if (typeof value === "string") return capText(value, maxBytes) ?? "";
  let text: string;
  try {
    const serialized = JSON.stringify(value);
    text = serialized === undefined ? "null" : serialized;
  } catch {
    text = "null";
  }
  return capText(text, maxBytes) ?? "";
}

function parseJson<T>(value: string | null | undefined): T | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  return fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  return null;
}

function clampLimit(value: number, fallback: number, max: number): number {
  const number = finiteNumber(value, fallback);
  return Math.max(1, Math.min(max, number || fallback));
}

function textOrNull(value: unknown, cap: number): string | null {
  if (value === null || value === undefined) return null;
  return capText(String(value), cap);
}

function boolInt(value: unknown): number {
  return value === true || value === 1 || value === "1" ? 1 : 0;
}

let idSequence = 0;

/** Opaque local id; the caller supplies ids only for goals. */
function newId(prefix: string): string {
  idSequence += 1;
  return `${prefix}${Date.now().toString(36)}${idSequence.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`.toLowerCase();
}

function zeroUsage(): GoalUsage {
  return {
    steps: 0,
    tool_calls: 0,
    active_ms: 0,
    tokens: 0,
    model_steps: 0,
    replans: 0,
  };
}

const BUDGET_KEYS: ReadonlyArray<keyof GoalBudget> = [
  "max_steps",
  "max_tool_calls",
  "max_active_ms",
  "max_tokens",
  "max_attempts_per_step",
  "max_replans",
  "max_wait_ms",
];

const USAGE_KEYS: ReadonlyArray<keyof GoalUsage> = [
  "steps",
  "tool_calls",
  "active_ms",
  "tokens",
  "model_steps",
  "replans",
];

/** Merge numeric overrides over a base budget, dropping non-finite values. */
function mergeBudget(base: GoalBudget, patch?: Partial<GoalBudget> | null): GoalBudget {
  const next = { ...base };
  if (!patch || typeof patch !== "object") return next;
  for (const key of BUDGET_KEYS) {
    const value = patch[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      next[key] = Math.max(0, Math.trunc(value));
    }
  }
  return next;
}

function mergeUsage(base: GoalUsage, patch?: Partial<GoalUsage> | null): GoalUsage {
  const next = { ...base };
  if (!patch || typeof patch !== "object") return next;
  for (const key of USAGE_KEYS) {
    const value = patch[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      next[key] = Math.max(0, Math.trunc(value));
    }
  }
  return next;
}

function parseBudget(raw: string | null | undefined): GoalBudget {
  return mergeBudget(DEFAULT_BUDGET, parseJson<Partial<GoalBudget>>(raw));
}

export interface GoalPatch {
  title?: string;
  brief?: string;
  success_criteria?: string;
  workspace_source?: string | null;
  status?: GoalStatus;
  paused?: number | boolean;
  plan_version?: number;
  current_step_id?: string | null;
  summary?: string | null;
  last_error?: string | null;
  budget_json?: string;
  usage_json?: string;
  /** Merged over the current stored budget (or DEFAULT_BUDGET). */
  budget?: Partial<GoalBudget>;
  /** Merged over the current stored usage. */
  usage?: Partial<GoalUsage>;
  started_at?: number | null;
  finished_at?: number | null;
  updated_at?: number;
}

export interface StepPatch {
  status?: StepStatus;
  attempts?: number;
  wake_at?: number | null;
  lease_token?: string | null;
  lease_until?: number | null;
  evidence_json?: string | null;
  /** Object form encoded and capped by the store. */
  evidence?: unknown;
  result_json?: string | null;
  result?: unknown;
  last_error?: string | null;
  started_at?: number | null;
  finished_at?: number | null;
  updated_at?: number;
}

export interface GoalRunPatch {
  status?: GoalRunStatus;
  usage_json?: string | null;
  usage?: Partial<GoalUsage>;
  result_json?: string | null;
  result?: unknown;
  error?: string | null;
  started_at?: number | null;
  finished_at?: number | null;
}

export interface GoalEventInput {
  goal_id: string;
  step_id?: string | null;
  run_id?: string | null;
  type: GoalEventType;
  actor?: GoalActor;
  payload_json?: unknown;
  /** Object form used when payload_json is absent. */
  payload?: unknown;
  created_at: number;
}

export interface GoalToolCallInput {
  goal_id: string;
  step_id?: string | null;
  run_id?: string | null;
  tool: string;
  input_hash?: string | null;
  side_effect?: number | boolean;
  result_json?: unknown;
  result?: unknown;
  created_at: number;
}

export interface GoalAttentionInput {
  goal_id: string;
  kind: GoalAttentionKind;
  title: string;
  body?: string | null;
  created_at: number;
}

export class GoalStore {
  sql: SqlHandle;

  constructor(sql: SqlHandle) {
    this.sql = sql;
  }

  /** Idempotent schema for every coordinator-side goal table and index. */
  ensureSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      origin_session_id TEXT,
      workspace_source TEXT,
      title TEXT NOT NULL,
      brief TEXT NOT NULL,
      success_criteria TEXT NOT NULL,
      status TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,
      plan_version INTEGER NOT NULL DEFAULT 0,
      budget_json TEXT NOT NULL,
      usage_json TEXT NOT NULL,
      current_step_id TEXT,
      summary TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    )`);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS goals_status_updated ON goals(status, updated_at)"
    );
    this.sql.exec("CREATE INDEX IF NOT EXISTS goals_session ON goals(session_id)");
    const terminal = TERMINAL_GOAL_STATUSES.map((status) => `'${status}'`).join(", ");
    this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS goals_one_live_per_session
      ON goals(session_id)
      WHERE status NOT IN (${terminal})`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS goal_steps (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      plan_version INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      done_when TEXT NOT NULL,
      checks_json TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL,
      wake_at INTEGER,
      lease_token TEXT,
      lease_until INTEGER,
      evidence_json TEXT,
      result_json TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS goal_steps_plan
      ON goal_steps(goal_id, plan_version, seq)`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS goal_plans (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      plan_json TEXT NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS goal_plans_version
      ON goal_plans(goal_id, version)`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS goal_runs (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      usage_json TEXT,
      result_json TEXT,
      error TEXT,
      started_at INTEGER,
      finished_at INTEGER
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS goal_runs_started
      ON goal_runs(goal_id, started_at)`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS goal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id TEXT NOT NULL,
      step_id TEXT,
      run_id TEXT,
      type TEXT NOT NULL,
      actor TEXT NOT NULL,
      payload_json TEXT,
      created_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS goal_events_goal
      ON goal_events(goal_id, id)`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS goal_tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id TEXT NOT NULL,
      step_id TEXT,
      run_id TEXT,
      tool TEXT NOT NULL,
      input_hash TEXT,
      side_effect INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      created_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS goal_tool_calls_goal
      ON goal_tool_calls(goal_id, id)`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS goal_attention (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS goal_attention_unread
      ON goal_attention(read, created_at)`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS goal_instructions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS goal_instructions_goal
      ON goal_instructions(goal_id, id)`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS goal_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )`);
  }

  create(input: NewGoalInput, now: number, id: string): GoalRow {
    const budget = mergeBudget(DEFAULT_BUDGET, input.budget);
    const usage = zeroUsage();
    const title = capText(input.title, MAX_TITLE_BYTES) ?? "";
    const brief = capText(input.brief, GOAL_PAYLOAD_LIMITS.briefBytes) ?? "";
    const criteria =
      capText(input.success_criteria, GOAL_PAYLOAD_LIMITS.successCriteriaBytes) ?? "";
    const workspace =
      input.workspace_source !== undefined
        ? capText(input.workspace_source, MAX_TITLE_BYTES)
        : input.origin_session_id
          ? "origin"
          : "empty";

    this.sql.exec(
      `INSERT INTO goals (
         id, session_id, origin_session_id, workspace_source, title, brief,
         success_criteria, status, paused, plan_version, budget_json, usage_json,
         current_step_id, summary, last_error, created_at, updated_at, started_at,
         finished_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'planning', 0, 0, ?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL)`,
      id,
      input.session_id,
      input.origin_session_id ?? null,
      workspace,
      title,
      brief,
      criteria,
      capJson(budget, MAX_USAGE_BYTES),
      capJson(usage, MAX_USAGE_BYTES),
      now,
      now
    );
    const row = this.get(id);
    if (!row) throw new Error("goal insert did not return a row");
    return row;
  }

  get(id: string): GoalRow | null {
    return (
      this.sql.exec<GoalRow>("SELECT * FROM goals WHERE id = ?", id).results[0] ?? null
    );
  }

  list(statuses?: GoalStatus[] | string | null, limit = 100): GoalRow[] {
    const requested =
      typeof statuses === "string" ? [statuses] : Array.isArray(statuses) ? statuses : [];
    const values: Array<string | number | null> = [];
    let where = "";
    if (requested.length > 0) {
      where = ` WHERE status IN (${requested.map(() => "?").join(", ")})`;
      for (const status of requested) values.push(status);
    }
    values.push(clampLimit(limit, 100, 200));
    return this.sql.exec<GoalRow>(
      `SELECT * FROM goals${where} ORDER BY updated_at DESC, id DESC LIMIT ?`,
      ...values
    ).results;
  }

  /** Whitelisted columns only; no caller-provided key ever reaches SQL text. */
  update(id: string, patch: GoalPatch): GoalRow | null {
    const source = patch as unknown as Record<string, unknown>;
    const sets: string[] = [];
    const values: Array<string | number | null> = [];

    if (source.title !== undefined) {
      sets.push("title = ?");
      values.push(textOrNull(source.title, MAX_TITLE_BYTES) ?? "");
    }
    if (source.brief !== undefined) {
      sets.push("brief = ?");
      values.push(textOrNull(source.brief, GOAL_PAYLOAD_LIMITS.briefBytes) ?? "");
    }
    if (source.success_criteria !== undefined) {
      sets.push("success_criteria = ?");
      values.push(
        textOrNull(source.success_criteria, GOAL_PAYLOAD_LIMITS.successCriteriaBytes) ?? ""
      );
    }
    if (source.workspace_source !== undefined) {
      sets.push("workspace_source = ?");
      values.push(textOrNull(source.workspace_source, MAX_TITLE_BYTES));
    }
    if (source.status !== undefined) {
      sets.push("status = ?");
      values.push(textOrNull(source.status, 64) ?? "planning");
    }
    if (source.paused !== undefined) {
      sets.push("paused = ?");
      values.push(boolInt(source.paused));
    }
    if (source.plan_version !== undefined) {
      sets.push("plan_version = ?");
      values.push(Math.max(0, finiteNumber(source.plan_version)));
    }
    if (source.current_step_id !== undefined) {
      sets.push("current_step_id = ?");
      values.push(textOrNull(source.current_step_id, MAX_ID_BYTES));
    }
    if (source.summary !== undefined) {
      sets.push("summary = ?");
      values.push(textOrNull(source.summary, MAX_SUMMARY_BYTES));
    }
    if (source.last_error !== undefined) {
      sets.push("last_error = ?");
      values.push(textOrNull(source.last_error, MAX_ERROR_BYTES));
    }
    if (source.budget_json !== undefined) {
      sets.push("budget_json = ?");
      values.push(capJson(source.budget_json, MAX_USAGE_BYTES));
    }
    if (source.usage_json !== undefined) {
      sets.push("usage_json = ?");
      values.push(capJson(source.usage_json, MAX_USAGE_BYTES));
    }
    if (source.budget !== undefined) {
      const current = this.get(id);
      const merged = mergeBudget(
        parseBudget(current?.budget_json),
        source.budget as Partial<GoalBudget>
      );
      sets.push("budget_json = ?");
      values.push(capJson(merged, MAX_USAGE_BYTES));
    }
    if (source.usage !== undefined) {
      const current = this.get(id);
      const merged = mergeUsage(
        mergeUsage(zeroUsage(), parseJson<Partial<GoalUsage>>(current?.usage_json)),
        source.usage as Partial<GoalUsage>
      );
      sets.push("usage_json = ?");
      values.push(capJson(merged, MAX_USAGE_BYTES));
    }
    if (source.started_at !== undefined) {
      sets.push("started_at = ?");
      values.push(nullableNumber(source.started_at));
    }
    if (source.finished_at !== undefined) {
      sets.push("finished_at = ?");
      values.push(nullableNumber(source.finished_at));
    }

    sets.push("updated_at = ?");
    values.push(nullableNumber(source.updated_at) ?? Date.now());
    values.push(id);
    this.sql.exec(`UPDATE goals SET ${sets.join(", ")} WHERE id = ?`, ...values);
    return this.get(id);
  }

  addPlan(
    goalId: string,
    version: number,
    planJson: unknown,
    reason: string | null,
    now: number
  ): GoalPlanRow {
    const id = newId("pl");
    this.sql.exec(
      `INSERT INTO goal_plans (id, goal_id, version, plan_json, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      goalId,
      Math.max(0, finiteNumber(version)),
      capJson(planJson, GOAL_PAYLOAD_LIMITS.planBytes),
      textOrNull(reason, MAX_PLAN_REASON_BYTES),
      now
    );
    const row = this.sql.exec<GoalPlanRow>(
      "SELECT * FROM goal_plans WHERE id = ?",
      id
    ).results[0];
    if (!row) throw new Error("goal plan insert did not return a row");
    return row;
  }

  addSteps(goalId: string, version: number, steps: PlanStep[], now: number): StepRow[] {
    const goal = this.get(goalId);
    const budget = parseBudget(goal?.budget_json);
    const planVersion = Math.max(0, finiteNumber(version));
    const current = this.sql.exec<{ n: number }>(
      `SELECT COALESCE(MAX(seq), 0) AS n FROM goal_steps
       WHERE goal_id = ? AND plan_version = ?`,
      goalId,
      planVersion
    ).results[0];
    let seq = finiteNumber(current?.n);

    const inserted: StepRow[] = [];
    for (const step of steps) {
      const id = newId("st");
      seq += 1;
      const kind = step.kind === "wait" ? "wait" : "work";
      const wakeAt =
        nullableNumber(step.wake_at) ??
        (kind === "wait" && typeof step.wait_minutes === "number" && Number.isFinite(step.wait_minutes)
          ? now + Math.max(0, Math.trunc(step.wait_minutes)) * 60_000
          : null);
      const maxAttempts =
        nullableNumber(step.max_attempts) ??
        (kind === "wait" ? 1 : budget.max_attempts_per_step);
      this.sql.exec(
        `INSERT INTO goal_steps (
           id, goal_id, plan_version, seq, kind, title, objective, done_when,
           checks_json, status, attempts, max_attempts, wake_at, lease_token,
           lease_until, evidence_json, result_json, last_error, created_at,
           updated_at, started_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)`,
        id,
        goalId,
        planVersion,
        seq,
        kind,
        capText(step.title, MAX_TITLE_BYTES) ?? "",
        capText(step.objective, GOAL_PAYLOAD_LIMITS.objectiveBytes) ?? "",
        capText(step.done_when, GOAL_PAYLOAD_LIMITS.objectiveBytes) ?? "",
        step.checks === undefined
          ? null
          : capJson(step.checks, GOAL_PAYLOAD_LIMITS.checksBytes),
        Math.max(0, maxAttempts),
        wakeAt,
        now,
        now
      );
      const row = this.getStep(id);
      if (row) inserted.push(row);
    }
    return inserted;
  }

  steps(goalId: string): StepRow[] {
    return this.sql.exec<StepRow>(
      `SELECT * FROM goal_steps WHERE goal_id = ?
       ORDER BY plan_version ASC, seq ASC, id ASC`,
      goalId
    ).results;
  }

  getStep(id: string): StepRow | null {
    return (
      this.sql.exec<StepRow>("SELECT * FROM goal_steps WHERE id = ?", id).results[0] ??
      null
    );
  }

  /**
   * First queued work step of the current plan, claimed only when no step of
   * this goal is already running or verifying. Both statements run in one
   * synchronous DO turn, so no other claim can interleave.
   */
  claimStep(goalId: string, now: number, leaseMs: number, token: string): StepRow | null {
    const candidate = this.sql.exec<StepRow>(
      `SELECT * FROM goal_steps
       WHERE goal_id = ?
         AND status = 'queued'
         AND kind = 'work'
         AND plan_version = (
           SELECT COALESCE(MAX(plan_version), 0) FROM goal_steps WHERE goal_id = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM goal_steps
           WHERE goal_id = ? AND status IN ('running', 'verifying')
         )
       ORDER BY plan_version ASC, seq ASC, id ASC
       LIMIT 1`,
      goalId,
      goalId,
      goalId
    ).results[0];
    if (!candidate) return null;

    const leaseUntil = now + Math.max(0, finiteNumber(leaseMs));
    this.sql.exec(
      `UPDATE goal_steps
       SET status = 'running', attempts = attempts + 1, lease_token = ?,
           lease_until = ?, started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ? AND status = 'queued'`,
      capText(token, MAX_ID_BYTES),
      leaseUntil,
      now,
      now,
      candidate.id
    );
    const row = this.getStep(candidate.id);
    return row && row.status === "running" ? row : null;
  }

  updateStep(id: string, patch: StepPatch): StepRow | null {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];

    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.attempts !== undefined) {
      sets.push("attempts = ?");
      values.push(Math.max(0, finiteNumber(patch.attempts)));
    }
    if (patch.wake_at !== undefined) {
      sets.push("wake_at = ?");
      values.push(nullableNumber(patch.wake_at));
    }
    if (patch.lease_token !== undefined) {
      sets.push("lease_token = ?");
      values.push(textOrNull(patch.lease_token, MAX_ID_BYTES));
    }
    if (patch.lease_until !== undefined) {
      sets.push("lease_until = ?");
      values.push(nullableNumber(patch.lease_until));
    }
    if (patch.evidence_json !== undefined) {
      sets.push("evidence_json = ?");
      values.push(
        patch.evidence_json === null
          ? null
          : capJson(patch.evidence_json, GOAL_PAYLOAD_LIMITS.evidenceBytes)
      );
    }
    if (patch.evidence !== undefined) {
      sets.push("evidence_json = ?");
      values.push(
        patch.evidence === null
          ? null
          : capJson(patch.evidence, GOAL_PAYLOAD_LIMITS.evidenceBytes)
      );
    }
    if (patch.result_json !== undefined) {
      sets.push("result_json = ?");
      values.push(
        patch.result_json === null
          ? null
          : capJson(patch.result_json, GOAL_PAYLOAD_LIMITS.resultBytes)
      );
    }
    if (patch.result !== undefined) {
      sets.push("result_json = ?");
      values.push(
        patch.result === null
          ? null
          : capJson(patch.result, GOAL_PAYLOAD_LIMITS.resultBytes)
      );
    }
    if (patch.last_error !== undefined) {
      sets.push("last_error = ?");
      values.push(textOrNull(patch.last_error, MAX_ERROR_BYTES));
    }
    if (patch.started_at !== undefined) {
      sets.push("started_at = ?");
      values.push(nullableNumber(patch.started_at));
    }
    if (patch.finished_at !== undefined) {
      sets.push("finished_at = ?");
      values.push(nullableNumber(patch.finished_at));
    }

    sets.push("updated_at = ?");
    values.push(nullableNumber(patch.updated_at) ?? Date.now());
    values.push(id);
    this.sql.exec(`UPDATE goal_steps SET ${sets.join(", ")} WHERE id = ?`, ...values);
    return this.getStep(id);
  }

  /** Duplicate run ids are ignored; the existing row is returned unchanged. */
  insertRun(run: GoalRunRow): GoalRunRow | null {
    this.sql.exec(
      `INSERT INTO goal_runs (
         id, goal_id, step_id, session_id, status, usage_json, result_json,
         error, started_at, finished_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      run.id,
      run.goal_id,
      run.step_id,
      run.session_id,
      run.status,
      run.usage_json === null || run.usage_json === undefined
        ? null
        : capJson(run.usage_json, MAX_USAGE_BYTES),
      run.result_json === null || run.result_json === undefined
        ? null
        : capJson(run.result_json, GOAL_PAYLOAD_LIMITS.resultBytes),
      textOrNull(run.error, MAX_ERROR_BYTES),
      run.started_at ?? null,
      run.finished_at ?? null
    );
    return this.getRun(run.id);
  }

  getRun(id: string): GoalRunRow | null {
    return (
      this.sql.exec<GoalRunRow>("SELECT * FROM goal_runs WHERE id = ?", id).results[0] ??
      null
    );
  }

  updateRun(id: string, patch: GoalRunPatch): GoalRunRow | null {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];

    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.usage_json !== undefined) {
      sets.push("usage_json = ?");
      values.push(
        patch.usage_json === null ? null : capJson(patch.usage_json, MAX_USAGE_BYTES)
      );
    }
    if (patch.usage !== undefined) {
      sets.push("usage_json = ?");
      values.push(capJson(patch.usage, MAX_USAGE_BYTES));
    }
    if (patch.result_json !== undefined) {
      sets.push("result_json = ?");
      values.push(
        patch.result_json === null
          ? null
          : capJson(patch.result_json, GOAL_PAYLOAD_LIMITS.resultBytes)
      );
    }
    if (patch.result !== undefined) {
      sets.push("result_json = ?");
      values.push(
        patch.result === null
          ? null
          : capJson(patch.result, GOAL_PAYLOAD_LIMITS.resultBytes)
      );
    }
    if (patch.error !== undefined) {
      sets.push("error = ?");
      values.push(textOrNull(patch.error, MAX_ERROR_BYTES));
    }
    if (patch.started_at !== undefined) {
      sets.push("started_at = ?");
      values.push(nullableNumber(patch.started_at));
    }
    if (patch.finished_at !== undefined) {
      sets.push("finished_at = ?");
      values.push(nullableNumber(patch.finished_at));
    }
    if (sets.length === 0) return this.getRun(id);
    values.push(id);
    this.sql.exec(`UPDATE goal_runs SET ${sets.join(", ")} WHERE id = ?`, ...values);
    return this.getRun(id);
  }

  /** Insert and return the row (AUTOINCREMENT id) without an affected count. */
  addEvent(event: GoalEventInput): GoalEventRow {
    const payload =
      event.payload_json !== undefined
        ? capJson(event.payload_json, GOAL_PAYLOAD_LIMITS.eventBytes)
        : event.payload !== undefined
          ? capJson(event.payload, GOAL_PAYLOAD_LIMITS.eventBytes)
          : null;
    this.sql.exec(
      `INSERT INTO goal_events (goal_id, step_id, run_id, type, actor, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      event.goal_id,
      event.step_id ?? null,
      event.run_id ?? null,
      event.type,
      event.actor ?? "system",
      payload,
      finiteNumber(event.created_at)
    );
    const row = this.sql.exec<GoalEventRow>(
      "SELECT * FROM goal_events WHERE id = last_insert_rowid()"
    ).results[0];
    if (!row) throw new Error("goal event insert did not return a row");
    return row;
  }

  /** Oldest first after the row-id cursor, for an append-only audit tail. */
  listEvents(goalId: string, after: number | null = null, limit = 100): GoalEventRow[] {
    const capped = clampLimit(limit, 100, 1000);
    if (after === null || after === undefined || !Number.isFinite(after)) {
      return this.sql.exec<GoalEventRow>(
        `SELECT * FROM goal_events WHERE goal_id = ?
         ORDER BY id ASC LIMIT ?`,
        goalId,
        capped
      ).results;
    }
    return this.sql.exec<GoalEventRow>(
      `SELECT * FROM goal_events WHERE goal_id = ? AND id > ?
       ORDER BY id ASC LIMIT ?`,
      goalId,
      after,
      capped
    ).results;
  }

  addToolCall(call: GoalToolCallInput): GoalToolCallRow {
    const result =
      call.result_json !== undefined
        ? capJson(call.result_json, GOAL_PAYLOAD_LIMITS.toolResultBytes)
        : call.result !== undefined
          ? capJson(call.result, GOAL_PAYLOAD_LIMITS.toolResultBytes)
          : null;
    this.sql.exec(
      `INSERT INTO goal_tool_calls (
         goal_id, step_id, run_id, tool, input_hash, side_effect, result_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      call.goal_id,
      call.step_id ?? null,
      call.run_id ?? null,
      textOrNull(call.tool, MAX_ID_BYTES) ?? "",
      textOrNull(call.input_hash, MAX_ID_BYTES),
      boolInt(call.side_effect),
      result,
      finiteNumber(call.created_at)
    );
    const row = this.sql.exec<GoalToolCallRow>(
      "SELECT * FROM goal_tool_calls WHERE id = last_insert_rowid()"
    ).results[0];
    if (!row) throw new Error("goal tool call insert did not return a row");
    return row;
  }

  addAttention(item: GoalAttentionInput): GoalAttentionRow {
    this.sql.exec(
      `INSERT INTO goal_attention (goal_id, kind, title, body, read, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
      item.goal_id,
      item.kind,
      capText(item.title, MAX_TITLE_BYTES) ?? "",
      textOrNull(item.body, MAX_ATTENTION_BODY_BYTES),
      finiteNumber(item.created_at)
    );
    const row = this.sql.exec<GoalAttentionRow>(
      "SELECT * FROM goal_attention WHERE id = last_insert_rowid()"
    ).results[0];
    if (!row) throw new Error("goal attention insert did not return a row");
    return row;
  }

  /** Unread attention rows, newest first. */
  listAttention(limit = 20): GoalAttentionRow[] {
    return this.sql.exec<GoalAttentionRow>(
      `SELECT * FROM goal_attention WHERE read = 0
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      clampLimit(limit, 20, 100)
    ).results;
  }

  markAttentionRead(id: number): GoalAttentionRow | null {
    this.sql.exec("UPDATE goal_attention SET read = 1 WHERE id = ?", id);
    return (
      this.sql.exec<GoalAttentionRow>(
        "SELECT * FROM goal_attention WHERE id = ?",
        id
      ).results[0] ?? null
    );
  }

  addInstruction(goalId: string, content: string, now: number): GoalInstructionRow {
    const capped = capText(content, GOAL_PAYLOAD_LIMITS.instructionBytes) ?? "";
    this.sql.exec(
      "INSERT INTO goal_instructions (goal_id, content, created_at) VALUES (?, ?, ?)",
      goalId,
      capped,
      finiteNumber(now)
    );
    const row = this.sql.exec<GoalInstructionRow>(
      "SELECT * FROM goal_instructions WHERE id = last_insert_rowid()"
    ).results[0];
    if (!row) throw new Error("goal instruction insert did not return a row");
    return row;
  }

  instructions(goalId: string): GoalInstructionRow[] {
    return this.sql.exec<GoalInstructionRow>(
      "SELECT * FROM goal_instructions WHERE goal_id = ? ORDER BY id ASC",
      goalId
    ).results;
  }

  meta(key: string): string | null {
    const row = this.sql.exec<{ value: string | null }>(
      "SELECT value FROM goal_meta WHERE key = ?",
      key
    ).results[0];
    return row ? row.value : null;
  }

  setMeta(key: string, value: string | null): void {
    this.sql.exec(
      `INSERT INTO goal_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value
    );
  }

  /** The single non-terminal goal that owns this dedicated session, if any. */
  activeGoalForSession(sessionId: string): GoalRow | null {
    const terminal = TERMINAL_GOAL_STATUSES.map((status) => `'${status}'`).join(", ");
    return (
      this.sql.exec<GoalRow>(
        `SELECT * FROM goals WHERE session_id = ? AND status NOT IN (${terminal})
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        sessionId
      ).results[0] ?? null
    );
  }

  /**
   * Delete at most `limit` events older than `before`. Rows are selected first
   * because SqlHandle exposes no affected-row count.
   */
  pruneEvents(goalId: string, before: number, limit = 500): number {
    const capped = clampLimit(limit, 500, 5000);
    const rows = this.sql.exec<{ id: number }>(
      `SELECT id FROM goal_events WHERE goal_id = ? AND created_at < ?
       ORDER BY created_at ASC, id ASC LIMIT ?`,
      goalId,
      finiteNumber(before),
      capped
    ).results;
    for (const row of rows) {
      this.sql.exec("DELETE FROM goal_events WHERE id = ?", row.id);
    }
    return rows.length;
  }
}
