// Shared, dependency-free shapes for automations. No SDK imports so Node tests
// can import this directly through type stripping.

export type AutomationKind = "webhook" | "github" | "watch" | "schedule";
export type AutomationStatus = "active" | "paused" | "auto_paused";
export type EventStatus =
  | "received"
  | "matched"
  | "skipped"
  | "duplicate"
  | "rate_limited"
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "session_missing";
export type RunStatus = "submitting" | "running" | "done" | "failed" | "abandoned";

export type MatchOp =
  | "eq"
  | "neq"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "exists"
  | "gt"
  | "lt"
  | "in";

export type MatchNode =
  | { all: MatchNode[] }
  | { any: MatchNode[] }
  | { path: string; op: MatchOp; value?: unknown };

export interface WatchSource {
  type: "watch";
  url: string;
  interval_minutes: number;
  fire_on_first?: boolean;
  headers?: Record<string, string>;
}

export interface ScheduleSource {
  type: "schedule";
  every_minutes?: number;
  daily_at?: string;
}

export interface WebhookSource {
  type: "webhook";
  auth: "secret" | "github";
}

export type AutomationSource = WatchSource | ScheduleSource | WebhookSource;

export interface AutomationRow {
  id: string;
  name: string;
  kind: AutomationKind;
  enabled: number;
  target_session_id: string;
  instructions: string;
  source_json: string;
  match_json: string | null;
  secret_enc: string | null;
  secret_hint: string | null;
  cooldown_ms: number;
  max_per_hour: number;
  next_run_at: number | null;
  last_event_at: number | null;
  last_run_at: number | null;
  last_error: string | null;
  consecutive_failures: number;
  created_at: number;
  updated_at: number;
}

export interface AutomationEventRow {
  id: string;
  automation_id: string;
  event_key: string;
  source: string;
  event_type: string | null;
  payload_json: string;
  headers_json: string | null;
  status: EventStatus;
  reason: string | null;
  run_id: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
}

export interface AutomationRunRow {
  id: string;
  automation_id: string;
  event_id: string;
  session_id: string;
  stream_id: string | null;
  operation_id: string | null;
  status: RunStatus;
  reply: string | null;
  error: string | null;
  attempts: number;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
}

export interface WatchStateRow {
  automation_id: string;
  fingerprint: string | null;
  last_value: string | null;
  last_checked_at: number | null;
  last_status: number | null;
  consecutive_errors: number;
}

export interface CreateAutomationInput {
  name: string;
  kind: AutomationKind;
  target_session_id: string;
  instructions: string;
  source: AutomationSource;
  match?: MatchNode | null;
  cooldown_ms?: number;
  max_per_hour?: number;
}

export interface UpdateAutomationInput {
  name?: string;
  instructions?: string;
  target_session_id?: string;
  match?: MatchNode | null;
  cooldown_ms?: number;
  max_per_hour?: number;
}

export interface AutomationPatch {
  name?: string;
  target_session_id?: string;
  instructions?: string;
  source_json?: string;
  match_json?: string | null;
  enabled?: number;
  cooldown_ms?: number;
  max_per_hour?: number;
  next_run_at?: number | null;
  last_event_at?: number | null;
  last_run_at?: number | null;
  last_error?: string | null;
  consecutive_failures?: number;
  updated_at?: number;
}

export interface AutomationListFilter {
  status?: AutomationStatus;
  kind?: AutomationKind;
}

export interface SubmitAutomationInput {
  sessionId: string;
  prompt: string;
  automationId: string;
  runId: string;
}

export interface SessionSubmitResult {
  ok: boolean;
  streamId?: string;
  operationId?: string;
  error?: string;
}

export interface SessionTurnStatus {
  status: "running" | "done" | "error" | "unknown";
  reply?: string;
  error?: string;
}

export interface SessionPort {
  exists(sessionId: string): Promise<boolean>;
  submit(input: SubmitAutomationInput): Promise<SessionSubmitResult>;
  status(sessionId: string, streamId: string): Promise<SessionTurnStatus>;
}

export interface AutomationLimits {
  maxBodyBytes: number;
  maxPayloadBytes: number;
  maxInstructionsBytes: number;
  maxMatchBytes: number;
  maxHeadersBytes: number;
  defaultCooldownMs: number;
  defaultMaxPerHour: number;
  maxQueuedPerAutomation: number;
  maxQueuedGlobal: number;
  maxRunningGlobal: number;
  maxRunsPerDay: number;
  watchMinIntervalMinutes: number;
  watchTimeoutMs: number;
  watchMaxBytes: number;
  watchMaxErrors: number;
  eventRetentionMs: number;
  maxEventsPerAutomation: number;
  maxRunsPerAutomation: number;
  maxMatchNodes: number;
}

export const AUTOMATION_LIMITS: AutomationLimits = {
  maxBodyBytes: 128 * 1024,
  maxPayloadBytes: 32 * 1024,
  maxInstructionsBytes: 8 * 1024,
  maxMatchBytes: 8 * 1024,
  maxHeadersBytes: 8 * 1024,
  defaultCooldownMs: 10_000,
  defaultMaxPerHour: 20,
  maxQueuedPerAutomation: 20,
  maxQueuedGlobal: 50,
  maxRunningGlobal: 2,
  maxRunsPerDay: 200,
  watchMinIntervalMinutes: 5,
  watchTimeoutMs: 10_000,
  watchMaxBytes: 256 * 1024,
  watchMaxErrors: 10,
  eventRetentionMs: 30 * 24 * 60 * 60 * 1000,
  maxEventsPerAutomation: 5_000,
  maxRunsPerAutomation: 5_000,
  maxMatchNodes: 32,
};

export const AUTOMATION_READY_BODY = "automation store";

export function isAutomationId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]{8,32}$/.test(value);
}

export function isAutomationKind(value: unknown): value is AutomationKind {
  return value === "webhook" || value === "github" || value === "watch" || value === "schedule";
}

export function isTerminalEvent(status: EventStatus): boolean {
  return (
    status === "duplicate" ||
    status === "skipped" ||
    status === "rate_limited" ||
    status === "done" ||
    status === "failed" ||
    status === "session_missing"
  );
}

export function isTerminalRun(status: RunStatus): boolean {
  return status === "done" || status === "failed" || status === "abandoned";
}
