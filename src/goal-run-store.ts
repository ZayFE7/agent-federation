// Session-side durable state for one goal run. The coordinator owns goal state;
// this module owns only the active run, its operation chain, and the write-ahead
// tool ledger that makes crash retries safe.

import type { SqlHandle } from "./memory";

export interface ActiveGoalRunRow {
  run_id: string;
  goal_id: string;
  step_id: string;
  lease_token: string;
  prompt: string;
  checks_json: string | null;
  status: "running" | "approval" | "aborted" | "done" | "failed";
  model_steps: number;
  tool_calls: number;
  tokens: number;
  active_ms: number;
  started_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface GoalRunOperationRow {
  run_id: string;
  operation_id: string;
  root: number;
  status: "running" | "done" | "failed" | "aborted" | "pending_approval";
  usage_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface GoalRunToolRow {
  id: number;
  run_id: string;
  goal_id: string;
  step_id: string;
  tool: string;
  input_hash: string;
  side_effect: number;
  status: "intent" | "finished" | "failed";
  result_json: string | null;
  created_at: number;
  updated_at: number;
}

export function ensureGoalRunSchema(sql: SqlHandle): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS goal_active_runs (
    run_id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    session_id TEXT NOT NULL UNIQUE,
    lease_token TEXT NOT NULL,
    prompt TEXT NOT NULL,
    checks_json TEXT,
    status TEXT NOT NULL,
    model_steps INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0,
    active_ms INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS goal_run_ops (
    operation_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    root INTEGER NOT NULL,
    status TEXT NOT NULL,
    usage_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS goal_run_ops_run ON goal_run_ops(run_id, created_at)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS goal_run_tools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    goal_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    side_effect INTEGER NOT NULL,
    status TEXT NOT NULL,
    result_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS goal_run_tools_run ON goal_run_tools(run_id, id)`);
}

export function startGoalRun(sql: SqlHandle, row: ActiveGoalRunRow & { session_id: string }): boolean {
  const existing = getActiveGoalRun(sql, row.session_id);
  if (existing) return false;
  sql.exec(
    `INSERT INTO goal_active_runs
      (run_id, goal_id, step_id, session_id, lease_token, prompt, checks_json,
       status, model_steps, tool_calls, tokens, active_ms, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, NULL, ?, ?)`,
    row.run_id,
    row.goal_id,
    row.step_id,
    row.session_id,
    row.lease_token,
    row.prompt,
    row.checks_json,
    row.status,
    row.created_at,
    row.updated_at
  );
  return true;
}

export function getActiveGoalRun(sql: SqlHandle, sessionId: string): ActiveGoalRunRow | null {
  return (
    sql.exec<ActiveGoalRunRow>(
      "SELECT * FROM goal_active_runs WHERE session_id = ? LIMIT 1",
      sessionId
    ).results[0] ?? null
  );
}

export function updateGoalRun(
  sql: SqlHandle,
  runId: string,
  patch: Partial<
    Pick<
      ActiveGoalRunRow,
      | "status"
      | "model_steps"
      | "tool_calls"
      | "tokens"
      | "active_ms"
      | "started_at"
      | "updated_at"
    >
  >
): void {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  for (const key of [
    "status",
    "model_steps",
    "tool_calls",
    "tokens",
    "active_ms",
    "started_at",
    "updated_at",
  ] as const) {
    if (patch[key] === undefined) continue;
    sets.push(`${key} = ?`);
    values.push(patch[key] as string | number | null);
  }
  if (sets.length === 0) return;
  values.push(runId);
  sql.exec(`UPDATE goal_active_runs SET ${sets.join(", ")} WHERE run_id = ?`, ...values);
}

export function clearGoalRun(sql: SqlHandle, runId: string): void {
  sql.exec("DELETE FROM goal_active_runs WHERE run_id = ?", runId);
}

export function upsertGoalOperation(sql: SqlHandle, row: GoalRunOperationRow): void {
  sql.exec(
    `INSERT INTO goal_run_ops (operation_id, run_id, root, status, usage_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(operation_id) DO UPDATE SET status = excluded.status,
       usage_json = excluded.usage_json, updated_at = excluded.updated_at`,
    row.operation_id,
    row.run_id,
    row.root,
    row.status,
    row.usage_json,
    row.created_at,
    row.updated_at
  );
}

export function listGoalOperations(sql: SqlHandle, runId: string): GoalRunOperationRow[] {
  return sql.exec<GoalRunOperationRow>(
    "SELECT * FROM goal_run_ops WHERE run_id = ? ORDER BY created_at ASC",
    runId
  ).results;
}

export function intentGoalTool(
  sql: SqlHandle,
  row: Omit<GoalRunToolRow, "id" | "created_at" | "updated_at" | "status">
): number {
  const now = Date.now();
  sql.exec(
    `INSERT INTO goal_run_tools
      (run_id, goal_id, step_id, tool, input_hash, side_effect, status, result_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'intent', NULL, ?, ?)`,
    row.run_id,
    row.goal_id,
    row.step_id,
    row.tool,
    row.input_hash,
    row.side_effect,
    now,
    now
  );
  const found = sql.exec<{ id: number }>(
    "SELECT id FROM goal_run_tools WHERE run_id = ? ORDER BY id DESC LIMIT 1",
    row.run_id
  ).results[0];
  return found?.id ?? 0;
}

export function finishGoalTool(
  sql: SqlHandle,
  id: number,
  status: "finished" | "failed",
  resultJson: string
): void {
  sql.exec(
    "UPDATE goal_run_tools SET status = ?, result_json = ?, updated_at = ? WHERE id = ?",
    status,
    resultJson.slice(0, 16_000),
    Date.now(),
    id
  );
}

export function listGoalTools(sql: SqlHandle, runId: string): GoalRunToolRow[] {
  return sql.exec<GoalRunToolRow>(
    "SELECT * FROM goal_run_tools WHERE run_id = ? ORDER BY id ASC",
    runId
  ).results;
}
