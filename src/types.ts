// Shared contract types for the federation agent worker and Durable Object.
// This module stays type-import-only so a dependency-free consumer (src/routes.ts)
// can read it, and so an offline test can assert on it as text.

import type { MemoryRow, MessageRow } from "./memory";
import type { MessageAttachment } from "./attachments";
import type { ArtifactRow } from "./artifact-store";
import type { SessionRow } from "./registry-store";
import type { ModelDefault, ModelProvider } from "./model-store";
import type { ProviderInput } from "./model-input";
import type {
  AutomationEventRow,
  AutomationListFilter,
  AutomationRow,
  AutomationRunRow,
  CreateAutomationInput,
  UpdateAutomationInput,
} from "./automation-types";
import type {
  GmailAccessResult,
  GoogleAccountView,
  GoogleStatusView,
} from "./google-types";
import type {
  GoalAttentionRow,
  GoalBudget,
  GoalEventRow,
  GoalRow,
} from "./goal-types";

/** One model selection: a provider row plus a model id inside it. */
export interface ModelChoice {
  provider: string;
  model: string;
}

/** What the per-chat picker needs, without exposing any provider keys. */
export interface ModelChoiceInfo {
  model: string | null;
  provider: string;
  pinned: string;
  defaultProvider: string | null;
  defaultModel: string | null;
}

/** One connected MCP server, as the console lists it. */
export interface McpServerView {
  id: string;
  name: string;
  url: string;
  state: string;
  error: string | null;
  toolCount: number;
  authUrl: string | null;
}

/** One tool a connected MCP server exposes. */
export interface McpToolView {
  serverId: string;
  serverName: string;
  name: string;
  description: string;
  params: string;
}

export interface McpCatalog {
  servers: McpServerView[];
  tools: McpToolView[];
}

/** One installed skill without its full body. */
export interface SkillView {
  name: string;
  description: string;
  fileCount?: number;
  source?: string;
}

export interface SkillFileView {
  path: string;
  bytes: number;
}

export interface SkillDefinition extends SkillView {
  body: string;
  files: SkillFileView[];
  source?: string;
}

/** One file inside a skill package, base64 for storage and transport. */
export interface SkillPackageFile extends SkillFileView {
  contentBase64: string;
}

export interface SkillPackage {
  name: string;
  description: string;
  body: string;
  source: string;
  files: SkillPackageFile[];
}

/** Router lane. Agent uses primary|cheap; jev is reserved for the router's third lane. */
export type Tier = "primary" | "cheap" | "jev";

/** Tier accepted on the public HTTP/WS API (jev reserved for later). */
export type ChatTier = "primary" | "cheap";

/** OpenAI-style chat message. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** One tool invocation the model made while producing a reply. */
export interface ToolRun {
  /** Tool function name, e.g. "exec" | "lookup_online" | "schedule_task" | "save_workspace". */
  name: string;
  /** What was invoked: the shell command, or the job title for schedule_task. */
  cmd: string;
  /** Captured stdout/stderr (or the scheduler's confirmation line). */
  output: string;
  /** Whether the invocation reported success. */
  ok: boolean;
}

/** Response shape for the DO chat method (WebSocket turns and scheduled jobs). */
export interface AgentReply {
  reply: string;
  /** Deterministic mascot state (replaces the flaky LLM decider). */
  state?: string;
  /** Short capsule verb matching the state. */
  verb?: string;
  /** Tool cards the UI renders; empty when the model only talked. */
  tools?: ToolRun[];
  /**
   * Set when a high-risk command is parked for human approval. The harness
   * identifies the parked call by its string toolCallId; there is no row id
   * (Task 15, R70).
   */
  pending?: { toolCallId: string; name: string; cmd: string };
  /**
   * Set when this DO refused the work because the session id it was handed is not
   * its own (Task 8). src/routes.ts maps it to HTTP 403 `{ok:false,error:"invalid
   * session"}` and skips the registry `touch`: a refused request is not activity.
   *
   * A `code` field, not a thrown error, for two measured reasons: a throw inside
   * `chat`'s existing `try` would come back as an HTTP 200 carrying an error string,
   * and a value that crosses a DO RPC boundary arrives in another realm, so
   * `instanceof` on anything the DO threw can never be true in the worker. Only
   * strings and plain objects survive the hop.
   */
  code?: "invalid_session" | "goal_active";
}

/** Inbound body for WebSocket {type:"chat"}. */
export interface ChatRequest {
  content: string;
  tier?: ChatTier;
}

/**
 * The receipt a durably submitted turn hands back (plan Task 23). The response
 * returns before the model runs; the console opens `streamId` to watch what the
 * operation produces. Both ids are the DO's own, never derived by the worker.
 */
export interface TurnReceipt {
  operationId: string;
  streamId: string;
  /**
   * True when another turn was already open in the session and the harness is
   * holding this one behind it. The console shows the message as queued and
   * starts watching this stream only when the running turn settles.
   */
  queued?: boolean;
}

/** One full-text hit inside a session transcript. */
export interface MessageSearchHit {
  id: string;
  role: string;
  content: string;
  createdAt?: string;
  sessionId: string;
  sessionTitle: string;
}

/** The DO refused a human turn: wrong session, a goal step owns it, or a directive
 * arrived while another turn was running. */
export interface TurnRefusal {
  code: "invalid_session" | "goal_active" | "busy_directive";
}

/** Who asked for a turn. Only a human may use the deterministic directive path. */
export type TurnOrigin =
  | { kind: "human" }
  | { kind: "automation"; automationId: string; runId: string }
  | { kind: "goal"; goalId: string; stepId: string; runId: string; leaseToken: string };

export interface StartGoalStepInput {
  sessionId: string;
  goalId: string;
  stepId: string;
  runId: string;
  leaseToken: string;
  prompt: string;
  checks: unknown[];
}

export interface GoalStepCompletion {
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

/** Reconciliation answer for an automation run whose callback was lost. */
export interface SessionTurnStatus {
  status: "running" | "done" | "error" | "unknown";
  reply?: string;
  error?: string;
}

/** What the session reports when an automation-origin turn settles. */
export interface AutomationRunCompletion {
  runId: string;
  automationId: string;
  sessionId: string;
  status: "done" | "error";
  reply?: string;
  error?: string;
}

export interface AutomationCreateReply {
  ok: boolean;
  automation?: AutomationRow;
  secret?: string;
  error?: string;
}

export interface AutomationIngestReply {
  status:
    | "accepted"
    | "duplicate"
    | "invalid"
    | "not_found"
    | "too_large"
    | "disabled"
    | "skipped"
    | "rate_limited";
  eventId?: string;
  reason?: string;
}

export interface AutomationControlReply {
  ok: boolean;
  secret?: string;
  prompt?: string;
  error?: string;
}

/** The RPC surface AutomationAgent exposes to sessions, routes, and tools. */
export interface AutomationAgentStub {
  completeRun(input: AutomationRunCompletion): Promise<void>;
  ingestHook(input: {
    automationId: string;
    mode: "generic" | "github";
    pathSecret?: string;
    bodyText: string;
    headers: Record<string, string>;
    contentType: string | null;
  }): Promise<AutomationIngestReply>;
  createAutomation(input: CreateAutomationInput): Promise<AutomationCreateReply>;
  listAutomations(filter: AutomationListFilter, limit: number): Promise<AutomationRow[]>;
  getAutomation(id: string): Promise<AutomationRow | null>;
  updateAutomation(
    id: string,
    patch: UpdateAutomationInput
  ): Promise<{ ok: boolean; automation?: AutomationRow; error?: string }>;
  automationEvents(id: string, after: number, limit: number): Promise<AutomationEventRow[]>;
  automationRuns(id: string, limit: number): Promise<AutomationRunRow[]>;
  controlAutomation(
    id: string,
    action: "pause" | "resume" | "rotate_secret" | "retry_event" | "preview" | "delete",
    note?: string
  ): Promise<AutomationControlReply>;
  setGlobalPause(paused: boolean): Promise<void>;
  globalPaused(): Promise<boolean>;
  automationAttention(limit: number): Promise<AutomationEventRow[]>;
}

/** The RPC surface the goal coordinator exposes to sessions, routes, and tools. */
export interface AutonomyAgentStub {
  createGoal(input: {
    title: string;
    brief: string;
    success_criteria: string;
    origin_session_id?: string | null;
    budget?: Partial<GoalBudget>;
  }): Promise<{ ok: boolean; goal?: GoalRow; error?: string }>;
  completeGoalStep(input: GoalStepCompletion): Promise<void>;
  goalApprovalPending(input: {
    runId: string;
    goalId: string;
    stepId: string;
  }): Promise<void>;
  getGoal(id: string): Promise<GoalRow | null>;
  listGoals(statuses?: string[], limit?: number): Promise<GoalRow[]>;
  goalEvents(id: string, after: number | null, limit?: number): Promise<GoalEventRow[]>;
  controlGoal(
    id: string,
    action: "pause" | "resume" | "cancel" | "retry" | "instruct" | "budget",
    note?: string
  ): Promise<{ ok: boolean; error?: string }>;
  goalAttention(limit?: number): Promise<GoalAttentionRow[]>;
  readGoalAttention(id: number): Promise<boolean>;
  setGlobalPause(paused: boolean): Promise<void>;
  globalPaused(): Promise<boolean>;
  blocksDelete(sessionId: string): Promise<boolean>;
}

/** The parked approval as the console sees it: enough to re-mount its gate. */
export interface PendingApprovalView {
  toolCallId: string;
  name: string;
  cmd: string;
}

/** A read-only answer: `pending: null` means nothing is waiting. */
export interface PendingApprovalResult {
  ok: boolean;
  pending?: PendingApprovalView | null;
  error?: string;
}

/**
 * Minimal RPC surface of FederationAgent used over the DO stub.
 *
 * Lifted out of src/index.ts, where it was unexported (R39): src/routes.ts is
 * dependency-free by rule, so the shapes it addresses DOs with have to live
 * here. Nothing else may restate this interface.
 *
 * `chat` takes the session id LAST and optional (Task 8). That is not a style
 * choice: a required `sessionId` first would sit after an optional `tier`, which
 * TypeScript rejects, and the remaining unscoped call sites (the WebSocket path
 * and `onScheduledTask` in src/agent.ts) have to keep compiling. An absent id
 * means "unscoped", which stays main-only.
 *
 * `messages` is Task 7's addition (R59): the transcript of one session, read from
 * that session's own DO. It returns MessageRow, the store's row shape with
 * `created_at` included, not UIMessage and not a {role, content} summary of one.
 * OLDEST FIRST, deliberately: `recentMessages` reverses a DESC select
 * (src/memory.ts:143-149), so the newest turn is the LAST element. The console
 * day-groups this list, and a sort added here would be a second definition of
 * transcript order (R71 amendment 3).
 */
export interface AgentStub {
  /** The DO's own HTTP entry: WS upgrades and internal routes such as /internal/stream. */
  fetch(request: Request): Promise<Response>;
  /**
   * Durably submit one turn and return its stream id without awaiting the model
   * (Task 23). `trace` is the caller's answer to the `X-Blip-Trace` gate: the DO
   * cannot read a header off an RPC call, so the route decides and says so.
   */
  submitTurn(
    content: string,
    tier: ChatTier | undefined,
    sessionId: string,
    trace: boolean,
    attachments?: MessageAttachment[],
    origin?: TurnOrigin
  ): Promise<TurnReceipt | TurnRefusal>;
  /** Stop one operation, or everything open in a session; false when nothing matched. */
  abortTurn(sessionId: string, operationId?: string): Promise<boolean>;
  /** Terminal-state reconciliation for a background turn whose callback was lost. */
  turnStatus(sessionId: string, streamId: string): Promise<SessionTurnStatus>;
  /** Start one goal step in this dedicated session. */
  startGoalStep(input: StartGoalStepInput): Promise<{ ok: boolean; error?: string }>;
  /** Abort the active goal run and report whether a side effect had started. */
  abortGoalRun(sessionId: string, runId: string): Promise<{ aborted: boolean; sideEffects: boolean }>;
  /** True while this session is owned by a running goal step. */
  goalActive(sessionId: string): Promise<boolean>;
  chat(content: string, tier?: ChatTier, sessionId?: string): Promise<AgentReply>;
  messages(limit?: number): Promise<MessageRow[]>;
  /** Full-text search over this session's transcript, newest-first per session. */
  searchMessages(
    sessionId: string,
    query: string,
    limit?: number
  ): Promise<Array<{
    id: string;
    role: string;
    content: string;
    createdAt?: string;
    sessionId?: string;
  }>>;
  /** Global memory, hybrid-ranked; main owns the store. */
  memoryRecall(query: string, limit: number): Promise<MemoryRow[]>;
  memoryStatus(): Promise<{ semantic: boolean; memories: number; vectors: number }>;
  memoryClear(): Promise<number>;
  /** Files the agent explicitly shared, newest first. */
  artifacts(sessionId: string): Promise<ArtifactRow[]>;
  jobList(): Promise<unknown[]>;
  approveToolCall(
    sessionId: string,
    toolCallId: string,
    approved: boolean,
    reason?: string
  ): Promise<{
    ok: boolean;
    reply: string;
    state: string;
    output?: string;
    /** Present on `state: "queued"`: the continuation's stream, so the console can watch it. */
    streamId?: string;
    operationId?: string;
  }>;
  /**
   * Task P8: the approval a reloaded console cannot see in a text transcript.
   * Read-only, session-scoped, and null when nothing is parked.
   */
  pendingApproval(sessionId: string): Promise<PendingApprovalResult>;
  vaultPut(key: string, idx: number, total: number, dataB64: string): Promise<void>;
  vaultPull(key: string): Promise<Uint8Array | null>;
  vaultChunk(key: string, idx: number): Promise<string | null>;
  vaultHealth(key: string): Promise<Record<string, unknown> | null>;
  vaultDelete(key: string): Promise<void>;
  /** Task 30: the pointer row for this session's last good snapshot. */
  workspaceState(sessionId: string): Promise<WorkspaceState>;
  /** Task 30: drop the pointer row once the archives behind it are gone. */
  clearWorkspace(sessionId: string): Promise<void>;
  /** Task 30: remove one file from a live workspace and re-snapshot it. */
  deleteWorkspaceFile(sessionId: string, path: string): Promise<WorkspaceDeleteResult>;
  /** Goal creation: force a snapshot of the origin session. */
  saveWorkspaceForGoal(sessionId: string): Promise<{ ok: boolean; output: string }>;
  /** Goal creation: seed the new goal session's workspace pointer. */
  adoptWorkspace(
    sessionId: string,
    row: { key: string; bytes: number; files: number; sha256: string; updated_at: number }
  ): Promise<void>;
  /** Previous write_file backups for one path. */
  listFileVersions(
    sessionId: string,
    path: string
  ): Promise<{
    ok: boolean;
    versions: Array<{ path: string; bytes: number; mtime: number }>;
    error?: string;
  }>;
  /** Restore one previous version, backing up the current bytes. */
  restoreFileVersion(
    sessionId: string,
    path: string,
    version: string
  ): Promise<{ ok: boolean; output: string }>;
  /** Console model picker: false means the session id does not belong to this DO. */
  setModel(sessionId: string, model: string | null, provider?: string): Promise<boolean>;
  /** Console model picker: the override for this session plus the pinned fallback. */
  modelChoice(sessionId: string): Promise<ModelChoiceInfo>;
  /** The global MCP catalog; main holds the connections. */
  mcpServers(): Promise<McpCatalog>;
  mcpAdd(
    name: string,
    url: string,
    headers: Record<string, string>,
    origin: string
  ): Promise<{ ok: boolean; id?: string; state?: string; authUrl?: string | null; error?: string }>;
  mcpRemove(id: string): Promise<boolean>;
  mcpReconnect(
    id: string
  ): Promise<{ ok: boolean; state?: string; authUrl?: string | null; error?: string }>;
  mcpCall(server: string, tool: string, input: Record<string, unknown>): Promise<string>;
  skillCatalog(): Promise<SkillView[]>;
  skillGet(name: string): Promise<SkillDefinition | null>;
  skillFiles(name: string): Promise<SkillPackageFile[] | null>;
  skillSave(
    name: string,
    description: string,
    body: string,
    files: SkillPackageFile[],
    source: string
  ): Promise<boolean>;
  skillDelete(name: string): Promise<boolean>;
}

/**
 * What the brain knows about one session's workspace without touching KV (Task 30).
 *
 * `saved` is the pointer row's own truth: the last archive that LANDED. `bytes`,
 * `files` and `updatedAt` describe that archive, and `overLimit` is the measured
 * size of the newest attempt that did not land, so a session that outgrew the
 * ceiling can be told in the Files tab before another save fails.
 */
export interface WorkspaceState {
  saved: boolean;
  bytes: number;
  files: number;
  updatedAt: number | null;
  overLimit: number | null;
  limit: number;
}

/**
 * The one file delete's outcome. `unavailable` separates "the sandbox could not be
 * reached at all" from "the file is not there": the first is a 502 the user can
 * retry, the second is a 409 that no retry fixes.
 */
export interface WorkspaceDeleteResult {
  ok: boolean;
  output: string;
  unavailable: boolean;
}

/**
 * RPC surface of RegistryAgent (src/registry.ts), addressed through
 * env.REGISTRY.idFromName("registry"), the only instance ever created.
 *
 * The four write methods return void: the platform cursor exposes
 * rowsRead/rowsWritten and no per-statement affected-row count, so a boolean
 * here would be a fiction (R37, R58). The console re-lists after a rename or a
 * delete, so nothing consumes one.
 *
 * `exists` is a read, so it is not that fiction: a row either is in the index or
 * is not. The worker needs it before it addresses a session DO, because a
 * well-formed id with no row would otherwise instantiate a DO whose transcript
 * can never appear in `GET /api/sessions` (R73 amendment 4, R74).
 */
export interface RegistryStub {
  list(limit: number): Promise<SessionRow[]>;
  put(row: SessionRow): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
  touch(id: string, opts?: { unreadDelta?: number }): Promise<void>;
  exists(id: string): Promise<boolean>;
  modelSettings(): Promise<{ providers: ModelProvider[]; default: ModelDefault | null }>;
  modelDefault(): Promise<ModelDefault | null>;
  saveModelProvider(id: string | null, input: ProviderInput): Promise<ModelProvider | null>;
  deleteModelProvider(id: string): Promise<boolean>;
  setModelDefault(provider: string, model: string): Promise<boolean>;
  skillCatalog(): Promise<SkillView[]>;
  skillGet(name: string): Promise<SkillDefinition | null>;
  skillFiles(name: string): Promise<SkillPackageFile[] | null>;
  skillSave(
    name: string,
    description: string,
    body: string,
    files: SkillPackageFile[],
    source: string
  ): Promise<boolean>;
  skillDelete(name: string): Promise<boolean>;
  googleStatus(origin: string): Promise<GoogleStatusView>;
  googleBegin(
    origin: string,
    loginHint?: string
  ): Promise<{ ok: boolean; authUrl?: string; redirectUri: string; error?: string }>;
  googleComplete(
    code: string,
    state: string
  ): Promise<{ ok: boolean; account?: GoogleAccountView; error?: string }>;
  googleAccounts(): Promise<GoogleAccountView[]>;
  googleSetDefault(id: string): Promise<boolean>;
  googleDelete(id: string): Promise<boolean>;
  gmailAccess(account: string): Promise<GmailAccessResult>;
}

/**
 * Current model pin. Both lanes use the same id until a measured cheaper
 * tool-capable lane exists; the new id is served through `ROUTER_URL`, and a
 * live tool round trip is the acceptance test after deploy.
 */
export const DEFAULT_MODEL_PRIMARY = "antigravity/gemini-3.8-flash-tiered";
export const DEFAULT_MODEL_CHEAP = "antigravity/gemini-3.8-flash-tiered";

/** The slice of the Workers AI binding this worker uses. */
export interface AiBinding {
  run(model: string, input: unknown): Promise<unknown>;
}

export interface Env {
  /** HTTPS URL of the Pipedream router workflow. */
  ROUTER_URL: string;
  /** Shared secret sent as Bearer to the router (router checks it if set). */
  ROUTER_KEY: string;
  /** Defaults below apply when these vars are unset in wrangler. */
  MODEL_PRIMARY?: string;
  MODEL_CHEAP?: string;
  /** Bearer token required by the console API routes and the WebSocket upgrade. */
  AGENT_API_KEY: string;
  /** Bearer token required by /internal/vault/* (9router state sync). */
  STATE_KEY: string;
  /** Public URL of the Render-hosted 9router (keep-alive cron target). */
  RENDER_URL?: string;
  /** Static UI assets (console). */
  ASSETS: Fetcher;
  /** Direct service binding to the zay-router worker (same account). */
  ROUTER?: Fetcher;
  /** Direct service binding to the zay-sandbox worker (same account). */
  SANDBOX?: Fetcher;
  /** Shared secret for the sandbox worker. */
  SBOX_TOKEN: string;
  /** Parallel AI Web Search API key (sent as x-api-key). Search degrades gracefully when unset. */
  PARALLEL_API_KEY?: string;
  /** Durable Object binding for FederationAgent (wrangler name: FEDERATION_AGENT). */
  FEDERATION_AGENT: DurableObjectNamespace;
  /**
   * Durable Object binding for RegistryAgent (wrangler name: REGISTRY): the one
   * session index the console sidebar lists. Addressed with
   * idFromName("registry").
   */
  REGISTRY: DurableObjectNamespace;
  /** Durable Object binding for AutomationAgent (wrangler name: AUTOMATION). */
  AUTOMATION: DurableObjectNamespace;
  /** Durable Object binding for the goal coordinator (wrangler name: AUTONOMY). */
  AUTONOMY: DurableObjectNamespace;
  /** Workers AI embeddings for semantic memory recall (wrangler binding: AI). */
  AI?: AiBinding;
  /** OpenAI-compatible media router for image, speech, and transcription. */
  MEDIA_API_BASE_URL?: string;
  MEDIA_API_KEY?: string;
  /** Composio project key for managed OAuth Gmail and other connectors. */
  COMPOSIO_API_KEY?: string;
  /** Google OAuth web client. Unset means the Connections page shows setup. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Optional fixed redirect URI; otherwise derived from the request origin. */
  GOOGLE_REDIRECT_URI?: string;
}
