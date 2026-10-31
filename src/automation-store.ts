// Durable automation state over SqlHandle. Every value is a ? binding, every
// statement is schema-local SQL, and nothing here imports the Agents SDK, so
// plain Node tests can drive it with node:sqlite through the same adapter the
// rest of the suite uses.
//
// The store returns raw rows, including secret_enc on automations. The HTTP
// layer is responsible for stripping secrets from public projections.

import {
  AUTOMATION_LIMITS,
  type AutomationEventRow,
  type AutomationListFilter,
  type AutomationPatch,
  type AutomationRow,
  type AutomationRunRow,
  type CreateAutomationInput,
  type WatchStateRow,
} from "./automation-types.ts";
import type { SqlHandle } from "./memory.ts";

export const EVENT_RETENTION_MS = AUTOMATION_LIMITS.eventRetentionMs;
export const RATE_WINDOW_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_REPLY_BYTES = 4 * 1024;
export const MAX_ERROR_BYTES = 4 * 1024;
export const MAX_WATCH_VALUE_BYTES = 4 * 1024;

/** Events carry an attempt counter for submission retries (not in the v1 design table). */
export type AutomationEventRecord = AutomationEventRow & { attempts: number };
export type AutomationEventInput = AutomationEventRow & { attempts?: number };

export interface AutomationEventUpdate {
  event_type?: string | null;
  payload_json?: string;
  headers_json?: string | null;
  status?: AutomationEventRow["status"];
  reason?: string | null;
  run_id?: string | null;
  attempts?: number;
  updated_at?: number;
}

export interface AutomationRunUpdate {
  stream_id?: string | null;
  operation_id?: string | null;
  status?: AutomationRunRow["status"];
  reply?: string | null;
  error?: string | null;
  attempts?: number;
  started_at?: number | null;
  finished_at?: number | null;
}

/** AutomationPatch plus the explicit clock the engine passes on writes. */
export type AutomationUpdatePatch = AutomationPatch & { updated_at?: number };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function byteSize(text: string): number {
  return encoder.encode(text).length;
}

/** UTF-8 aware cap: never splits a multi-byte code point. */
export function capText(
  value: string | null | undefined,
  maxBytes: number
): string | null {
  if (value === null || value === undefined) return null;
  const bytes = encoder.encode(value);
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return decoder.decode(bytes.subarray(0, end));
}

/** Serialize (unless already a JSON string) and cap before storage. */
export function capJson(value: unknown, maxBytes: number): string {
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

function clampLimit(value: number, fallback: number, max: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(max, number));
}

function finiteNumber(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  return null;
}

export class AutomationStore {
  sql: SqlHandle;

  constructor(sql: SqlHandle) {
    this.sql = sql;
  }

  /** Idempotent schema for every automation table and its lookup indexes. */
  ensureSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      target_session_id TEXT NOT NULL,
      instructions TEXT NOT NULL,
      source_json TEXT NOT NULL,
      match_json TEXT,
      secret_enc TEXT,
      secret_hint TEXT,
      cooldown_ms INTEGER NOT NULL,
      max_per_hour INTEGER NOT NULL,
      next_run_at INTEGER,
      last_event_at INTEGER,
      last_run_at INTEGER,
      last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS automation_events (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      source TEXT NOT NULL,
      event_type TEXT,
      payload_json TEXT NOT NULL,
      headers_json TEXT,
      status TEXT NOT NULL,
      reason TEXT,
      run_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_events_key
      ON automation_events (automation_id, event_key)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_automation_events_created
      ON automation_events (automation_id, created_at DESC, id DESC)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_automation_events_status
      ON automation_events (status, created_at ASC)`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      stream_id TEXT,
      operation_id TEXT,
      status TEXT NOT NULL,
      reply TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_automation_runs_created
      ON automation_runs (automation_id, created_at DESC, id DESC)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_automation_runs_session
      ON automation_runs (session_id, status)`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS automation_watch_state (
      automation_id TEXT PRIMARY KEY,
      fingerprint TEXT,
      last_value TEXT,
      last_checked_at INTEGER,
      last_status INTEGER,
      consecutive_errors INTEGER NOT NULL DEFAULT 0
    )`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS automation_rate (
      automation_id TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (automation_id, window_start)
    )`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS automation_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )`);
  }

  create(input: CreateAutomationInput, now: number, id: string): AutomationRow {
    const instructions = capText(input.instructions, AUTOMATION_LIMITS.maxInstructionsBytes) ?? "";
    const sourceJson = capJson(input.source, AUTOMATION_LIMITS.maxInstructionsBytes);
    const matchJson =
      input.match === undefined || input.match === null
        ? null
        : capJson(input.match, AUTOMATION_LIMITS.maxMatchBytes);
    const name = capText(input.name, 512) ?? "";
    const target = capText(input.target_session_id, 512) ?? "";
    const cooldown =
      input.cooldown_ms === undefined
        ? AUTOMATION_LIMITS.defaultCooldownMs
        : Math.max(0, Math.trunc(input.cooldown_ms));
    const maxPerHour =
      input.max_per_hour === undefined
        ? AUTOMATION_LIMITS.defaultMaxPerHour
        : Math.max(1, Math.trunc(input.max_per_hour));

    this.sql.exec(
      `INSERT INTO automations (
         id, name, kind, enabled, target_session_id, instructions, source_json,
         match_json, secret_enc, secret_hint, cooldown_ms, max_per_hour,
         next_run_at, last_event_at, last_run_at, last_error,
         consecutive_failures, created_at, updated_at
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, 0, ?, ?)`,
      id,
      name,
      input.kind,
      target,
      instructions,
      sourceJson,
      matchJson,
      cooldown,
      maxPerHour,
      now,
      now
    );
    const row = this.get(id);
    if (!row) throw new Error("automation insert did not return a row");
    return row;
  }

  get(id: string): AutomationRow | null {
    return (
      this.sql.exec<AutomationRow>("SELECT * FROM automations WHERE id = ?", id).results[0] ?? null
    );
  }

  list(filter: AutomationListFilter = {}, limit = 100): AutomationRow[] {
    const clauses: string[] = [];
    const values: Array<string | number | null> = [];
    if (filter.status === "active") {
      clauses.push("enabled = 1");
    } else if (filter.status === "paused") {
      clauses.push("enabled = 0");
    } else if (filter.status === "auto_paused") {
      clauses.push("enabled = 0");
      clauses.push("last_error IS NOT NULL");
    }
    if (filter.kind) {
      clauses.push("kind = ?");
      values.push(filter.kind);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    values.push(clampLimit(limit, 100, 200));
    return this.sql.exec<AutomationRow>(
      `SELECT * FROM automations${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ...values
    ).results;
  }

  /**
   * Update only whitelisted columns plus updated_at. Keys come from the
   * constant lists below, never from the caller, so no key reaches SQL text.
   */
  update(id: string, patch: AutomationUpdatePatch): AutomationRow | null {
    const source = patch as unknown as Record<string, unknown>;
    const sets: string[] = [];
    const values: Array<string | number | null> = [];

    const textColumns: Array<[string, number]> = [
      ["name", 512],
      ["target_session_id", 512],
      ["instructions", AUTOMATION_LIMITS.maxInstructionsBytes],
      ["source_json", AUTOMATION_LIMITS.maxInstructionsBytes],
    ];
    for (const [column, cap] of textColumns) {
      const value = source[column];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(capText(String(value), cap) ?? "");
    }

    if (source.match_json !== undefined) {
      sets.push("match_json = ?");
      values.push(
        source.match_json === null
          ? null
          : capJson(source.match_json, AUTOMATION_LIMITS.maxMatchBytes)
      );
    }
    if (source.last_error !== undefined) {
      sets.push("last_error = ?");
      values.push(
        source.last_error === null ? null : capText(String(source.last_error), MAX_ERROR_BYTES)
      );
    }

    const numberColumns: Array<[string, boolean]> = [
      ["enabled", false],
      ["cooldown_ms", false],
      ["max_per_hour", false],
      ["next_run_at", true],
      ["last_event_at", true],
      ["last_run_at", true],
      ["consecutive_failures", false],
    ];
    for (const [column, nullable] of numberColumns) {
      const raw = source[column];
      if (raw === undefined) continue;
      const number = finiteNumber(raw);
      if (number === null) {
        if (nullable && raw === null) {
          sets.push(`${column} = ?`);
          values.push(null);
        }
        continue;
      }
      sets.push(`${column} = ?`);
      values.push(column === "enabled" ? (number === 0 ? 0 : 1) : number);
    }

    sets.push("updated_at = ?");
    values.push(finiteNumber(source.updated_at) ?? Date.now());
    values.push(id);
    this.sql.exec(`UPDATE automations SET ${sets.join(", ")} WHERE id = ?`, ...values);
    return this.get(id);
  }

  setEnabled(id: string, enabled: boolean | number): void {
    this.sql.exec(
      "UPDATE automations SET enabled = ?, updated_at = ? WHERE id = ?",
      enabled ? 1 : 0,
      Date.now(),
      id
    );
  }

  rotateSecret(id: string, enc: string, hint: string | null, now: number): void {
    this.sql.exec(
      "UPDATE automations SET secret_enc = ?, secret_hint = ?, updated_at = ? WHERE id = ?",
      enc,
      hint,
      now,
      id
    );
  }

  /** Keep events/runs for audit when a trigger is deleted. */
  delete(id: string): void {
    this.sql.exec("DELETE FROM automations WHERE id = ?", id);
  }

  /**
   * True when this call inserted the row. ON CONFLICT DO NOTHING plus a
   * read-back replaces an affected-row count, which SqlHandle does not expose.
   */
  insertEvent(row: AutomationEventInput): boolean {
    const payload = capJson(row.payload_json, AUTOMATION_LIMITS.maxPayloadBytes);
    const headers =
      row.headers_json === null || row.headers_json === undefined
        ? null
        : capJson(row.headers_json, AUTOMATION_LIMITS.maxHeadersBytes);
    const reason =
      row.reason === null || row.reason === undefined
        ? null
        : capText(row.reason, MAX_ERROR_BYTES);
    this.sql.exec(
      `INSERT INTO automation_events (
         id, automation_id, event_key, source, event_type, payload_json,
         headers_json, status, reason, run_id, attempts, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(automation_id, event_key) DO NOTHING`,
      row.id,
      row.automation_id,
      row.event_key,
      row.source,
      row.event_type ?? null,
      payload,
      headers,
      row.status,
      reason,
      row.run_id ?? null,
      row.attempts ?? 0,
      row.created_at,
      row.updated_at
    );
    const stored = this.getEventByKey(row.automation_id, row.event_key);
    return stored !== null && stored.id === row.id;
  }

  getEvent(id: string): AutomationEventRecord | null {
    return (
      this.sql.exec<AutomationEventRecord>(
        "SELECT * FROM automation_events WHERE id = ?",
        id
      ).results[0] ?? null
    );
  }

  getEventByKey(automationId: string, eventKey: string): AutomationEventRecord | null {
    return (
      this.sql.exec<AutomationEventRecord>(
        "SELECT * FROM automation_events WHERE automation_id = ? AND event_key = ?",
        automationId,
        eventKey
      ).results[0] ?? null
    );
  }

  updateEvent(id: string, patch: AutomationEventUpdate): AutomationEventRecord | null {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];

    if (patch.event_type !== undefined) {
      sets.push("event_type = ?");
      values.push(
        patch.event_type === null ? null : capText(String(patch.event_type), 256)
      );
    }
    if (patch.payload_json !== undefined) {
      sets.push("payload_json = ?");
      values.push(capJson(patch.payload_json, AUTOMATION_LIMITS.maxPayloadBytes));
    }
    if (patch.headers_json !== undefined) {
      sets.push("headers_json = ?");
      values.push(
        patch.headers_json === null
          ? null
          : capJson(patch.headers_json, AUTOMATION_LIMITS.maxHeadersBytes)
      );
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.reason !== undefined) {
      sets.push("reason = ?");
      values.push(patch.reason === null ? null : capText(String(patch.reason), MAX_ERROR_BYTES));
    }
    if (patch.run_id !== undefined) {
      sets.push("run_id = ?");
      values.push(patch.run_id === null ? null : capText(String(patch.run_id), 256));
    }
    if (patch.attempts !== undefined) {
      sets.push("attempts = ?");
      values.push(finiteNumber(patch.attempts) ?? 0);
    }

    sets.push("updated_at = ?");
    values.push(finiteNumber(patch.updated_at) ?? Date.now());
    values.push(id);
    this.sql.exec(`UPDATE automation_events SET ${sets.join(", ")} WHERE id = ?`, ...values);
    return this.getEvent(id);
  }

  /**
   * Newest first. `after` is an epoch-ms cursor: only rows newer than it are
   * returned, which is what the console poll wants.
   */
  listEvents(
    automationId: string,
    after: number | null = null,
    limit = 50
  ): AutomationEventRecord[] {
    const capped = clampLimit(limit, 50, 500);
    if (after === null || !Number.isFinite(after)) {
      return this.sql.exec<AutomationEventRecord>(
        `SELECT * FROM automation_events WHERE automation_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
        automationId,
        capped
      ).results;
    }
    return this.sql.exec<AutomationEventRecord>(
      `SELECT * FROM automation_events WHERE automation_id = ? AND created_at > ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      automationId,
      after,
      capped
    ).results;
  }

  listQueuedEvents(limit = 20): AutomationEventRecord[] {
    return this.sql.exec<AutomationEventRecord>(
      `SELECT * FROM automation_events WHERE status = 'queued'
       ORDER BY created_at ASC, id ASC LIMIT ?`,
      clampLimit(limit, 20, 200)
    ).results;
  }

  /** Failed or blocked events for the Activity panel, newest first. */
  listAttention(limit = 20): AutomationEventRecord[] {
    return this.sql.exec<AutomationEventRecord>(
      `SELECT * FROM automation_events
       WHERE status IN ('failed', 'session_missing', 'rate_limited')
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      clampLimit(limit, 20, 100)
    ).results;
  }

  insertRun(row: AutomationRunRow): void {
    this.sql.exec(
      `INSERT INTO automation_runs (
         id, automation_id, event_id, session_id, stream_id, operation_id,
         status, reply, error, attempts, started_at, finished_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      row.id,
      row.automation_id,
      row.event_id,
      row.session_id,
      row.stream_id,
      row.operation_id,
      row.status,
      row.reply === null ? null : capText(row.reply, MAX_REPLY_BYTES),
      row.error === null ? null : capText(row.error, MAX_ERROR_BYTES),
      row.attempts,
      row.started_at,
      row.finished_at,
      row.created_at
    );
  }

  getRun(id: string): AutomationRunRow | null {
    return (
      this.sql.exec<AutomationRunRow>("SELECT * FROM automation_runs WHERE id = ?", id)
        .results[0] ?? null
    );
  }

  updateRun(id: string, patch: AutomationRunUpdate): AutomationRunRow | null {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];

    if (patch.stream_id !== undefined) {
      sets.push("stream_id = ?");
      values.push(patch.stream_id === null ? null : capText(String(patch.stream_id), 256));
    }
    if (patch.operation_id !== undefined) {
      sets.push("operation_id = ?");
      values.push(
        patch.operation_id === null ? null : capText(String(patch.operation_id), 256)
      );
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.reply !== undefined) {
      sets.push("reply = ?");
      values.push(patch.reply === null ? null : capText(String(patch.reply), MAX_REPLY_BYTES));
    }
    if (patch.error !== undefined) {
      sets.push("error = ?");
      values.push(patch.error === null ? null : capText(String(patch.error), MAX_ERROR_BYTES));
    }
    if (patch.attempts !== undefined) {
      sets.push("attempts = ?");
      values.push(finiteNumber(patch.attempts) ?? 0);
    }
    if (patch.started_at !== undefined) {
      sets.push("started_at = ?");
      values.push(finiteNumber(patch.started_at));
    }
    if (patch.finished_at !== undefined) {
      sets.push("finished_at = ?");
      values.push(finiteNumber(patch.finished_at));
    }
    if (sets.length === 0) return this.getRun(id);
    values.push(id);
    this.sql.exec(`UPDATE automation_runs SET ${sets.join(", ")} WHERE id = ?`, ...values);
    return this.getRun(id);
  }

  listRuns(automationId: string, limit = 50): AutomationRunRow[] {
    return this.sql.exec<AutomationRunRow>(
      `SELECT * FROM automation_runs WHERE automation_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      automationId,
      clampLimit(limit, 50, 500)
    ).results;
  }

  /** Runs that have not reached a terminal state and are older than `before`. */
  listStaleRuns(before: number, limit = 20): AutomationRunRow[] {
    return this.sql.exec<AutomationRunRow>(
      `SELECT * FROM automation_runs
       WHERE status IN ('submitting', 'running') AND created_at < ?
       ORDER BY created_at ASC, id ASC LIMIT ?`,
      before,
      clampLimit(limit, 20, 200)
    ).results;
  }

  activeRunForSession(sessionId: string): AutomationRunRow | null {
    return (
      this.sql.exec<AutomationRunRow>(
        `SELECT * FROM automation_runs
         WHERE session_id = ? AND status IN ('submitting', 'running')
         ORDER BY created_at ASC, id ASC LIMIT 1`,
        sessionId
      ).results[0] ?? null
    );
  }

  countRunningGlobal(): number {
    const row = this.sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM automation_runs WHERE status IN ('submitting', 'running')"
    ).results[0];
    return row ? Number(row.n) : 0;
  }

  countRunsSince(since: number): number {
    const row = this.sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM automation_runs WHERE created_at >= ?",
      since
    ).results[0];
    return row ? Number(row.n) : 0;
  }

  watchState(id: string): WatchStateRow | null {
    return (
      this.sql.exec<WatchStateRow>(
        "SELECT * FROM automation_watch_state WHERE automation_id = ?",
        id
      ).results[0] ?? null
    );
  }

  upsertWatchState(row: WatchStateRow): void {
    this.sql.exec(
      `INSERT INTO automation_watch_state (
         automation_id, fingerprint, last_value, last_checked_at,
         last_status, consecutive_errors
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(automation_id) DO UPDATE SET
         fingerprint = excluded.fingerprint,
         last_value = excluded.last_value,
         last_checked_at = excluded.last_checked_at,
         last_status = excluded.last_status,
         consecutive_errors = excluded.consecutive_errors`,
      row.automation_id,
      row.fingerprint,
      capText(row.last_value, MAX_WATCH_VALUE_BYTES),
      row.last_checked_at,
      row.last_status,
      row.consecutive_errors
    );
  }

  rateCount(id: string, windowStart: number): number {
    const row = this.sql.exec<{ count: number }>(
      "SELECT count FROM automation_rate WHERE automation_id = ? AND window_start = ?",
      id,
      windowStart
    ).results[0];
    return row ? Number(row.count) : 0;
  }

  bumpRate(id: string, windowStart: number): number {
    this.sql.exec(
      `INSERT INTO automation_rate (automation_id, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(automation_id, window_start) DO UPDATE SET count = count + 1`,
      id,
      windowStart
    );
    return this.rateCount(id, windowStart);
  }

  /**
   * Age retention first, then a per-automation cap using a LIMITed subquery so
   * the work stays bounded on SQLite (no huge OFFSET). Automations are kept.
   */
  prune(now: number): void {
    const cutoff = now - EVENT_RETENTION_MS;
    this.sql.exec("DELETE FROM automation_events WHERE created_at < ?", cutoff);
    this.sql.exec("DELETE FROM automation_runs WHERE created_at < ?", cutoff);
    this.sql.exec(
      "DELETE FROM automation_rate WHERE window_start < ?",
      now - RATE_WINDOW_RETENTION_MS
    );

    const automations = this.sql.exec<{ id: string }>("SELECT id FROM automations").results;
    for (const automation of automations) {
      this.sql.exec(
        `DELETE FROM automation_events WHERE automation_id = ? AND id NOT IN (
           SELECT id FROM automation_events WHERE automation_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?
         )`,
        automation.id,
        automation.id,
        AUTOMATION_LIMITS.maxEventsPerAutomation
      );
      this.sql.exec(
        `DELETE FROM automation_runs WHERE automation_id = ? AND id NOT IN (
           SELECT id FROM automation_runs WHERE automation_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?
         )`,
        automation.id,
        automation.id,
        AUTOMATION_LIMITS.maxRunsPerAutomation
      );
    }
  }

  meta(key: string): string | null {
    const row = this.sql.exec<{ value: string | null }>(
      "SELECT value FROM automation_meta WHERE key = ?",
      key
    ).results[0];
    return row ? row.value : null;
  }

  hasMeta(key: string): boolean {
    return this.meta(key) !== null;
  }

  setMeta(key: string, value: string | null): void {
    this.sql.exec(
      `INSERT INTO automation_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value
    );
  }
}
