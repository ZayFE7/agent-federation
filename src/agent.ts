import { Agent, type Connection } from "agents";
import { tracing } from "cloudflare:workers";
import { classifyContextOverflow } from "agents/harness/think";
import type {
  ThinkHarness,
  ThinkSessionEvent,
  ThinkTurnConfig,
  ThinkTurnContext,
  ThinkTurnEndContext,
} from "agents/harness/think";
import { Streams, sseResponse } from "agents/streams";
import type { ToolSet, UIMessage } from "ai";
import type {
  AgentReply,
  ChatRequest,
  ChatTier,
  Env,
  ModelChoiceInfo,
  PendingApprovalResult,
  RegistryStub,
  ToolRun,
  TurnReceipt,
  TurnRefusal,
  WorkspaceDeleteResult,
  WorkspaceState,
} from "./types";
import { DEFAULT_MODEL_CHEAP, DEFAULT_MODEL_PRIMARY } from "./types";
import { tracedTurn, turnTracing } from "./observability";
import {
  CONTINUATION_NUDGE,
  NO_SUMMARY,
  continuationInstruction,
  shouldContinue,
} from "./continuation";
import {
  EXPECTED_TOOLS,
  SANDBOX_HOME,
  buildSystemPrompt,
  capabilityAnswer,
  capabilitiesText,
  isCapabilityQuestion,
} from "./capabilities";
import {
  dueTasks,
  enqueueTask,
  ensureSchema,
  getModelOverride,
  listTasks,
  logMessage,
  nextDailyDue,
  recall,
  recentMessages,
  remember,
  setModelOverride,
  type MemoryRow,
  type MessageRow,
  type SqlHandle,
  type TaskRow,
} from "./memory";
import { toSqlHandle, type SqlTag } from "./sql-handle";
import { MAIN_DO_NAME, assertSessionScope, sessionScopeOk } from "./session-scope";
import { PLACEHOLDER_TITLE } from "./registry-store";
import { TITLE_MAX_TOKENS, parseTitle, titleMessages } from "./titles";
import {
  ensureVaultSchema,
  vaultDelete as vaultDeleteChunks,
  vaultGetBytes,
  vaultMeta,
  vaultPutChunk,
} from "./vault";
import { fetchRouter } from "./router";
import { summarizeConversation } from "./compact";
import { runInSandbox } from "./sandbox-client";
import { searchParallel as searchParallelWeb } from "./search-client";
import { parseDirective } from "./directives";
import { createPrimaryModel, createCustomModel } from "./provider";
import { buildHarness } from "./harness";
import { MAX_STEPS_CHAT } from "./harness-config";
import { Researcher } from "./child";
import { framesFromEvent, TOOL_WIDGET, type StreamFrame } from "./frames";
import { StreamHub, streamIdFor } from "./stream-hub";
import { messageText, replyFrom } from "./reply";
import { parkedApproval } from "./approval";
import {
  buildTools,
  childBusyRefusal,
  formatExecResult,
  formatSearchResults,
  formatSnapshotReply,
  snapshotPointer,
  MAX_CHILDREN_PER_SESSION,
  type DelegateInput,
  type ExecResult,
  type ScheduleInput,
  type SearchResult,
  type SnapshotReply,
  type SnapshotResult,
  type ToolDeps,
  type ToolProgress,
  type ToolProgressSink,
} from "./tools";
import {
  clearWorkspace as clearWorkspaceRow,
  ensureWorkspaceSchema,
  getWorkspace,
  recordSnapshot,
  recordTooLarge,
} from "./workspace-store";
import {
  SNAPSHOT_LIMIT_BYTES,
  quoteShellArg,
  safeWorkspacePath,
} from "./workspace-keys";
import type { ModelDefault, ModelProvider } from "./model-store";

/**
 * The two registry RPCs the title fiber calls (Task 9). A local shape rather
 * than RegistryStub because that interface is what src/routes.ts addresses;
 * this cast only has to describe the DO methods used here.
 */
interface TitleRegistry {
  get(id: string): Promise<{ title: string } | null>;
  rename(id: string, title: string): Promise<void>;
}

/**
 * The same DO row seen from a fired job: only the badge write. Its shape matches
 * `RegistryAgent.touch`, and a DO RPC stub is cast to the narrow interface it uses
 * because a missing method should fail here rather than at the call site.
 */
interface BadgeRegistry {
  touch(id: string, opts?: { unreadDelta?: number }): Promise<void>;
}

/** One stashed user turn, consumed by the matching onTurnEnd. */
interface StashedTurn {
  content: string;
  tier: ChatTier;
}

/** The narrow shape of a UIMessage part this file reads across the RPC boundary. */
interface ToolPartLike {
  type?: string;
  toolName?: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id?: string };
}

function isToolPart(part: ToolPartLike): boolean {
  const type = part.type ?? "";
  return type === "dynamic-tool" || (type.startsWith("tool-") && type.length > 5);
}

/**
 * Which tool a transcript part came from. `toolName` is what the SDK writes for a
 * dynamic tool; for a statically registered one the name is the `tool-` prefix on
 * `type`. Both are read because the turn-end hook has to know whether this turn
 * touched the sandbox, and that answer decides whether a snapshot is owed.
 */
function toolNameOf(part: ToolPartLike): string {
  if (typeof part.toolName === "string" && part.toolName) return part.toolName;
  const type = part.type ?? "";
  return type.startsWith("tool-") ? type.slice(5) : type;
}

/** The parked call's real approval id, read back off the transcript. */
function approvalIdOf(messages: readonly UIMessage[], toolCallId: string): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const raw of messages[i]?.parts ?? []) {
      const part = raw as ToolPartLike;
      if (!isToolPart(part)) continue;
      if (part.toolCallId !== toolCallId || part.state !== "approval-requested") continue;
      const id = part.approval?.id;
      if (typeof id === "string" && id) return id;
    }
  }
  return null;
}

/** The settled result of one tool call, after the turn continued. */
function toolOutputOf(messages: readonly UIMessage[], toolCallId: string): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const raw of messages[i]?.parts ?? []) {
      const part = raw as ToolPartLike;
      if (!isToolPart(part) || part.toolCallId !== toolCallId) continue;
      if (part.state === "output-error" && typeof part.errorText === "string") {
        return part.errorText;
      }
      if (part.state !== "output-available") continue;
      if (typeof part.output === "string") return part.output;
      if (part.output === undefined || part.output === null) return "";
      try {
        return JSON.stringify(part.output);
      } catch {
        return String(part.output);
      }
    }
  }
  return undefined;
}

/** One readable command/query line for a persisted tool card. */
function toolInputSummary(input: unknown): string {
  if (typeof input === "string") return input.replace(/\s+/g, " ").trim().slice(0, 500);
  if (input && typeof input === "object") {
    const value = input as Record<string, unknown>;
    for (const key of ["cmd", "query", "title", "goal"]) {
      if (typeof value[key] === "string") {
        return String(value[key]).replace(/\s+/g, " ").trim().slice(0, 500);
      }
    }
    try {
      return JSON.stringify(input).slice(0, 500);
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * The settled tool cards of one assistant message, serialized for the transcript.
 * The live stream is gone after a reload; this JSON is what lets the console
 * rebuild the same cards without replaying an operation.
 */
function persistedToolRuns(message: UIMessage | undefined): string | null {
  if (!message) return null;
  const runs: Array<{ name: string; cmd: string; output: string; ok: boolean }> = [];
  for (const raw of message.parts ?? []) {
    const part = raw as ToolPartLike;
    if (!isToolPart(part)) continue;
    if (part.state !== "output-available" && part.state !== "output-error") continue;
    const name = toolNameOf(part);
    if (!name) continue;
    const output =
      part.state === "output-error"
        ? String(part.errorText ?? "failed")
        : typeof part.output === "string"
          ? part.output
          : part.output == null
            ? ""
            : (() => {
                try {
                  return JSON.stringify(part.output);
                } catch {
                  return String(part.output);
                }
              })();
    runs.push({
      name,
      cmd: toolInputSummary(part.input),
      output: output.slice(0, 4000),
      ok: part.state === "output-available",
    });
  }
  if (runs.length === 0) return null;
  return JSON.stringify(runs).slice(0, 24_000);
}

export class FederationAgent extends Agent<Env> {
  private readonly harness: ThinkHarness<ToolSet>;
  private readonly streams: Streams;
  private readonly hub: StreamHub;
  private readonly turnUser = new Map<string, StashedTurn[]>();
  /** The running operation per session, so tool progress lands on its stream. */
  private readonly currentOp = new Map<string, string>();
  /**
   * Operation ids whose caller asked for a trace (Task 38). A sub-agent's turn is a
   * turn too and the plan wants it spanned, but the child is a separate DO with no
   * request to read, so the opt-in travels with the operation id instead. Cleared
   * where `currentOp` is, so a finished turn leaves nothing behind.
   */
  private readonly tracedOps = new Set<string>();
  /** Operations whose turn used a tool, keyed by the root op of the turn. */
  private readonly rootUsedTools = new Set<string>();
  /**
   * Continuation operations mapped to the stream their caller is already
   * reading. `continue()` starts a NEW operation, so without this map its
   * frames would land on a stream nobody has open while the console waits on
   * the root one.
   */
  private readonly continuationOps = new Map<
    string,
    { rootOp: string; rootStream: string; session: string; started: number }
  >();
  /** Continuation ops that need the "act, do not restate" nudge on their first step. */
  private readonly continuationNudgeOps = new Set<string>();
  /**
   * Sessions this isolate has already run a command for. It only decides whether
   * to warn that a workspace may have to be rebuilt, so a wrong answer costs one
   * extra line of progress, never a wrong file: the sandbox pool lives in the
   * sandbox worker's KV, and an evict that the worker reports clears the entry.
   */
  private readonly sandboxSeen = new Set<string>();
  /**
   * Sub-agent names this session has in flight. It is what makes the fan-out cap
   * real: the cap the model reads and the cap enforced here are the same constant,
   * and a name already working cannot be started twice against one facet.
   */
  private readonly childInFlight = new Set<string>();
  /** One in-flight answer per parked approval; a second click must not submit twice. */
  private readonly approving = new Set<string>();
  private schemaReady = false;
  /** Provider settings are global and change rarely; five seconds keeps a turn cheap. */
  private modelSettingsCache: {
    at: number;
    providers: ModelProvider[];
    default: ModelDefault | null;
  } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // ThinkHarness keeps its own private Streams bound directly in onStart(), so
    // there is no duplicate capability to collide with. Both instances read and
    // write the same two tables (cf_agents_streams, cf_agents_stream_blocks),
    // which is what makes one DO's chunks readable by both. Id namespaces are
    // disjoint: the harness writes think:<uuid>, the hub writes s:<session>:<op>.
    const streams = new Streams({ maxChunkBytes: 64 * 1024 });
    this.lifecycle.use(streams);
    this.streams = streams;
    this.hub = new StreamHub(streams, this.db());
    // Exactly one harness for every lane (R70). maxSteps is a construction-time
    // number in agents 0.28.1, and a second harness would mean a second Sessions
    // writer over the same transcript table.
    this.harness = buildHarness({
      env,
      tools: (session) => buildTools(this.toolDeps(session)),
      maxSteps: MAX_STEPS_CHAT,
      classifyError: classifyContextOverflow,
      onEvent: (session, ev) => this.mirrorEvent(session, ev),
      onTurnEnd: (turn) => this.onHarnessTurnEnd(turn),
      summarize: (text) => summarizeConversation(env, text),
      beforeTurn: (turn) => this.beforeTurn(turn),
    });
    this.lifecycle.use(this.harness);
  }

  /**
   * Mirror one harness event into its operation's durable stream. The observer
   * is synchronous and `open()` is not, so the hub buffers frames until the
   * writer exists; that is what keeps the first text delta from being lost.
   *
   * Settlement follows the terminal `operation` event, not `run-end`: run-end
   * fires before the result is settled and carries no text, and a model-call
   * error may still recover, so failing on `onError` would end a stream that
   * is about to continue.
   */
  private mirrorEvent(session: string, ev: ThinkSessionEvent): void {
    if (ev.type === "run-start") this.currentOp.set(session, ev.operationId);
    const frames = framesFromEvent(ev);
    // A parked call arrives as a `message` event, not a chunk, so the feed
    // cannot be chunk-only or the approve card never reaches the console.
    const eventOp =
      "operationId" in ev && typeof ev.operationId === "string"
        ? ev.operationId
        : this.currentOp.get(session);
    if (eventOp && frames.some((f) => f.t === "tool-start")) {
      this.rootUsedTools.add(this.rootOpFor(eventOp));
    }
    if (frames.length > 0 && eventOp) {
      this.hub.feed(this.streamForOp(session, eventOp), session, frames);
    }
    if (ev.type !== "operation") return;
    if (this.currentOp.get(session) === ev.status.operationId) {
      this.currentOp.delete(session);
    }
    this.tracedOps.delete(ev.status.operationId);
    const operationId = ev.status.operationId;
    const cont = this.continuationOps.get(operationId);
    const rootOp = cont?.rootOp ?? operationId;
    const streamId = cont?.rootStream ?? streamIdFor(session, operationId);
    if (ev.status.status === "done") {
      const text = ev.status.text ?? "";
      if (
        shouldContinue({
          status: "done",
          text,
          usedTools: this.rootUsedTools.has(rootOp),
          continuations: cont?.started ?? 0,
          isContinuation: Boolean(cont),
        })
      ) {
        this.startContinuation(session, rootOp, streamId, cont?.started ?? 0, text);
        return;
      }
      const finalText = text.trim() || (this.rootUsedTools.has(rootOp) ? NO_SUMMARY : "");
      this.clearContinuation(rootOp);
      this.hub.finish(streamId, session, finalText);
    } else if (ev.status.status === "unanswered") {
      this.clearContinuation(rootOp);
      this.hub.fail(streamId, ev.status.reason ?? "operation ended without an answer");
    }
  }

  /** The stream a reader is watching for this operation (a continuation inherits the root's). */
  private streamForOp(session: string, operationId: string): string {
    return this.continuationOps.get(operationId)?.rootStream ?? streamIdFor(session, operationId);
  }

  /** The operation a continuation belongs to, or the operation itself for a root turn. */
  private rootOpFor(operationId: string): string {
    return this.continuationOps.get(operationId)?.rootOp ?? operationId;
  }

  /**
   * Start one bounded continuation after a turn ended on a promise. The new
   * operation's frames are routed to the root's still-open stream, so the
   * console sees one continuous turn. The model is nudged in `beforeTurn`,
   * because `continue()` carries no user message.
   */
  private startContinuation(
    session: string,
    rootOp: string,
    rootStream: string,
    started: number,
    promise: string
  ): void {
    const operationId = crypto.randomUUID();
    this.continuationOps.set(operationId, {
      rootOp,
      rootStream,
      session,
      started: started + 1,
    });
    this.continuationNudgeOps.add(operationId);
    // `continue()` re-runs the model with no new input, and a reasoning model
    // tends to answer that with silence. A server-authored instruction gives it
    // an actual next step. It lives in the harness transcript only: the console
    // reads display rows, so this never appears as a user message.
    const instruction = continuationInstruction(promise);
    queueMicrotask(() => {
      void this.harness
        .session(session)
        .submit(instruction, { source: "server", operationId })
        .catch((err: unknown) => {
          console.error(`continuation failed: ${err instanceof Error ? err.stack : String(err)}`);
          this.clearContinuation(rootOp);
          this.hub.fail(rootStream, `continuation failed: ${String(err).slice(0, 200)}`);
        });
    });
  }

  /** Drop every in-memory record for one root turn. */
  private clearContinuation(rootOp: string): void {
    this.rootUsedTools.delete(rootOp);
    for (const [op, rec] of this.continuationOps) {
      if (rec.rootOp !== rootOp) continue;
      this.continuationOps.delete(op);
      this.continuationNudgeOps.delete(op);
    }
  }

  /** A tool's live progress, addressed to its call id on the operation's stream. */
  private emitToolProgress(session: string, toolCallId: string, p: ToolProgress): void {
    const operationId = this.currentOp.get(session);
    if (!operationId) return;
    this.hub.feed(this.streamForOp(session, operationId), session, [
      {
        t: "tool-progress",
        id: toolCallId,
        phase: p.phase,
        message: p.message,
        fraction: p.fraction,
        ...(p.tail === undefined ? {} : { tail: p.tail }),
      },
    ]);
  }

  /**
   * Task 31: one sub-agent's progress, landed on the parent's operation stream.
   *
   * A facet child owns its own `Streams` and its own SQLite, so a frame it writes
   * there is unreadable by the console: the console only ever opens the session
   * DO's stream, which is the one this instance holds. So the child sends its
   * frames over this RPC and this DO feeds its own hub.
   *
   * Both arguments are validated rather than trusted. A child is spawned by a
   * prompt the model wrote, so the session id it names has to be the one this DO
   * owns, and the stream id has to be that session's stream as `streamIdFor`
   * builds it. Anything else is dropped: appending another session's frames to
   * this turn, or appending to an id no reader will ever close, is worse than
   * saying nothing. The frame list is not capped, because the child's mapper only
   * turns tool events into frames, so one bounded child run produces a bounded
   * count.
   */
  async ingestChildFrames(
    sessionId: string,
    streamId: string,
    frames: StreamFrame[]
  ): Promise<void> {
    if (!sessionScopeOk(this.ctx, (name) => this.idFor(name), sessionId)) return;
    const prefix = `s:${sessionId}:`;
    const operationId = streamId.startsWith(prefix) ? streamId.slice(prefix.length) : "";
    if (!operationId || operationId.includes(":")) return;
    if (frames.length === 0) return;
    this.hub.feed(streamId, sessionId, frames);
  }

  /**
   * The one dereference of the registry namespace. Two callers, the title fiber and
   * the fired-job badge, and a second copy of the idFromName line is how a stub
   * address drifts away from the guard that pins it (R48).
   */
  private registryStub<T>(): T {
    return this.env.REGISTRY.get(
      this.env.REGISTRY.idFromName("registry")
    ) as unknown as T;
  }

  /**
   * Adapt the Agents SDK's tagged-template this.sql(strings, ...values) into
   * the exec-style SqlHandle used by memory helpers. The adapter itself is
   * src/sql-handle.ts, shared with the `db()` in src/registry.ts; this method
   * owns only the schema guards.
   */
  private db(): SqlHandle {
    const handle = toSqlHandle(this.sql.bind(this) as unknown as SqlTag);
    if (!this.schemaReady) {
      ensureSchema(handle);
      ensureVaultSchema(handle);
      ensureWorkspaceSchema(handle);
      this.schemaReady = true;
    }
    return handle;
  }

  /**
   * This class's own namespace, addressed by DO name. One dereference, so the
   * guard in `chat` and `isMainInstance` cannot drift apart (R77: `this.env` is
   * the SDK's real accessor, not a field invented here).
   */
  private idFor(name: string) {
    return this.env.FEDERATION_AGENT.idFromName(name);
  }

  /**
   * True when this instance IS the `main` DO, which is the only holder of the
   * global memory store (R45) and of the scheduler tick (R46). The predicate is the
   * same one the session guard uses, with `MAIN_DO_NAME` as the claimed session, so
   * there is no second copy of "does this DO own that id".
   */
  private isMainInstance(): boolean {
    return sessionScopeOk(this.ctx, (name) => this.idFor(name), MAIN_DO_NAME);
  }

  /**
   * A stub for the `main` DO, typed as this class, because a DO cannot read another
   * DO's SQLite: the only way a session instance can reach the global memory store
   * is an RPC to the instance that holds it (R45).
   */
  private mainStub(): FederationAgent {
    const stub = this.env.FEDERATION_AGENT.get(this.idFor(MAIN_DO_NAME));
    // Cast avoids depending on version-specific DurableObjectNamespace generics; the
    // stub's methods are this class's RPC surface.
    return stub as unknown as FederationAgent;
  }

  /**
   * R45, MEMORY STAYS GLOBAL. On main this is `remember` against the local `sql`,
   * exactly as the pre-shard call sites did. On any session DO the write is an RPC to
   * main, because transcripts shard per session and memory does not: every memory the
   * user has already accumulated lives in main's SQLite, so a "simplification" that
   * makes it per-DO would silently hide all of it and make the persona prose at
   * `DEFAULT_PERSONA`, the first capability bullet and the capability answer below
   * ("remember you across sessions") false in the same deploy.
   *
   * Best-effort like every other memory write here: a failed hop is logged and never
   * costs the turn the answer it belongs to. It does NOT write a local row: this DO's
   * own `memories` table is never read by `recallGlobal` (R45 asks main from every
   * instance), so a row dropped here would be invisible to every future recall while
   * still growing that session's database.
   */
  private async rememberGlobal(
    kind: string,
    text: string,
    importance: number
  ): Promise<void> {
    if (this.isMainInstance()) {
      remember(this.db(), kind, text, importance);
      return;
    }
    try {
      await this.mainStub().memoryRemember(kind, text, importance);
    } catch (err) {
      console.error(`global remember failed: ${String(err)}`);
    }
  }

  /** R45 again, on the read side: recall always asks main, from whatever DO runs. */
  private async recallGlobal(query: string, limit: number): Promise<MemoryRow[]> {
    if (this.isMainInstance()) return recall(this.db(), query, limit);
    return this.mainStub().memoryRecall(query, limit);
  }

  /**
   * R46, THE SCHEDULER LIVES ON MAIN ONLY. A task row is only ever fired by the alarm
   * of the DO that armed it, `onStart` arms on main and nowhere else, and
   * `GET /api/tasks` reads main (src/index.ts), so a session DO that inserted into its
   * own `tasks` table would produce a row nothing lists and nothing runs, while the
   * tool reply promised "It will run autonomously with tool access". Same shape as
   * R45: the write hops to the one DO that owns the store.
   *
   * Returns false when main refused the hop, so the tool can say so instead of
   * promising a wake that will not come. Task 33 owns the real scheduling redesign;
   * this is the honest version of the current one.
   */
  private async enqueueGlobal(
    title: string,
    dueAt: number,
    payload: string,
    recurrence: string | null
  ): Promise<boolean> {
    if (this.isMainInstance()) {
      enqueueTask(this.db(), title, dueAt, payload, recurrence);
      await this.armTick();
      return true;
    }
    try {
      await this.mainStub().taskEnqueue(title, dueAt, payload, recurrence);
      return true;
    } catch (err) {
      console.error(`global enqueue failed: ${String(err)}`);
      return false;
    }
  }

  /**
   * R46: the RPC that makes main's `tasks` table writable from a session DO. Re-arming
   * here is the point, not a bonus: the insert used to leave the wake to whatever alarm
   * was already set, so a job due in seconds waited up to the 60s poll.
   */
  async taskEnqueue(
    title: string,
    dueAt: number,
    payload: string,
    recurrence: string | null
  ): Promise<void> {
    enqueueTask(this.db(), title, dueAt, payload, recurrence);
    await this.armTick();
  }

  /**
   * R45: the two RPCs that make main's store reachable from a session DO. They run
   * `remember` / `recall` against this DO's own `db()`, exactly as the local call
   * sites do, and main is the only instance a session ever asks.
   */
  async memoryRemember(kind: string, text: string, importance: number): Promise<void> {
    remember(this.db(), kind, text, importance);
  }

  /** R45: one row-limit of global recall, as `recall` answers it locally. */
  async memoryRecall(query: string, limit: number): Promise<MemoryRow[]> {
    return recall(this.db(), query, limit);
  }

  async onStart(): Promise<void> {
    // Every DO keeps its own schema: a session DO needs its own `messages` table for
    // its own transcript (R41), which is the one thing that DOES shard.
    this.db();
    // R46: only main arms the tick. One alarm per DO is the platform's budget, and
    // `GET /api/tasks` only ever reads main, so a per-session alarm would be pure
    // burn; `enqueueGlobal` is what keeps that safe by making sure no session DO ever
    // holds a task row for that alarm to be needed for. Task 33 owns the redesign.
    if (!this.isMainInstance()) return;
    await this.armTick();
  }

  /**
   * HTTP traffic that is neither an RPC nor a WebSocket upgrade. The only route
   * this DO serves is the internal stream read; the worker proxies a public SSE
   * request here so `sseResponse` runs beside the Streams instance that owns the
   * chunks.
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const prefix = "/internal/stream/";
    if (request.method !== "GET" || !url.pathname.startsWith(prefix)) {
      return new Response("not found", { status: 404 });
    }
    let streamId: string;
    try {
      streamId = decodeURIComponent(url.pathname.slice(prefix.length));
    } catch {
      return new Response("not found", { status: 404 });
    }
    return this.internalStream(request, streamId);
  }

  /**
   * Serve one operation stream as SSE. The stream id names its session, and this DO
   * asserts that the named session is its own before reading a single chunk: a
   * routing mistake upstream must not turn one session's DO into a reader of
   * another session's stream.
   */
  async internalStream(request: Request, streamId: string): Promise<Response> {
    const match = /^s:([A-Za-z0-9_-]{1,40}):(.+)$/.exec(streamId);
    if (!match) return new Response("not found", { status: 404 });
    try {
      assertSessionScope(this.ctx, (name) => this.idFor(name), match[1]);
    } catch {
      return new Response("forbidden", { status: 403 });
    }
    return sseResponse(this.streams, streamId, {
      request,
      heartbeatMs: 30_000,
    });
  }

  /**
   * RPC/HTTP entry used by the worker.
   *
   * `sessionId` is LAST and optional (Task 8): an absent id means unscoped, which is
   * the pre-Phase-1 behaviour and stays main-only until Task 22 removes those callers.
   */
  async chat(content: string, tier?: ChatTier, sessionId?: string): Promise<AgentReply> {
    // The scope guard is the FIRST statement, ahead of the try below, and it RETURNS
    // rather than throwing: a throw inside that try would come back as an HTTP 200
    // carrying "agent error", and a thrown value crossing the RPC boundary arrives in
    // another realm where the worker's `instanceof` can never match. Only the string
    // `code` survives, which src/routes.ts turns into a 403.
    if (
      sessionId !== undefined &&
      !sessionScopeOk(this.ctx, (name) => this.idFor(name), sessionId)
    ) {
      return { reply: "", code: "invalid_session" };
    }
    const session = sessionId ?? MAIN_DO_NAME;
    try {
      const reply = await this.runTurn(content, tier, session);
      // Task 9: title work starts only after the reply exists and is never
      // awaited. The fiber's own placeholder check decides whether this turn
      // needs a title; an already-named session costs one registry read.
      this.startTitle(content, sessionId);
      return reply;
    } catch (err) {
      this.turnUser.delete(session);
      return { reply: "agent error: " + String(err) };
    }
  }

  /**
   * Task 23: durably submit one turn and return its stream id without awaiting
   * the model. A long multi-step build then outlives the Worker's wall clock: the
   * harness runs it from its own durable job queue, and the console watches the
   * operation stream. Deterministic turns (a directive or the capability answer)
   * open the same stream and write their own frames behind `waitUntil`.
   */
  async submitTurn(
    content: string,
    tier: ChatTier | undefined,
    sessionId: string,
    trace: boolean
  ): Promise<TurnReceipt | TurnRefusal> {
    if (!sessionScopeOk(this.ctx, (name) => this.idFor(name), sessionId)) {
      return { code: "invalid_session" };
    }
    const chatTier: ChatTier = tier === "cheap" ? "cheap" : "primary";
    // The operation id is ours so the stream exists before the first chunk: an
    // observer that only reacts to run-start would race the async open().
    const operationId = crypto.randomUUID();
    const streamId = streamIdFor(sessionId, operationId);
    await this.hub.open(streamId, sessionId);
    // Task 9's fiber takes its words from the triggering message and runs on its
    // own fiber, so starting it here cannot delay the submit response.
    this.startTitle(content, sessionId);
    logMessage(this.db(), "user", content, chatTier);

    const direct = this.directKind(content);
    if (direct) {
      // Still real work (a sandbox fetch can outlive the response), so it runs
      // behind waitUntil and reports through the same stream.
      this.ctx.waitUntil(
        this.streamDirect(content, direct, chatTier, sessionId, streamId)
      );
      return { operationId, streamId };
    }

    this.stashTurn(sessionId, { content, tier: chatTier });
    if (trace) this.tracedOps.add(operationId);
    try {
      // The span on this lane marks the submit, not the model: the harness runs a
      // durably submitted turn from its own job queue, and one span cannot span two
      // invocations without the truncation the SDK's tracing surface warns about. The
      // two ids still key it, so the queue's own spans hang off the same pair.
      // `trace` is the caller's header answer, so ordinary traffic pays for nothing.
      const receipt = await tracedTurn({
        tracing: trace ? turnTracing(this.env, tracing) : undefined,
        agent: "FederationAgent",
        sessionId,
        operationId,
        run: () =>
          this.harness.session(sessionId).submit(content, {
            source: "server",
            operationId,
          }),
      });
      return { operationId: receipt.operationId, streamId };
    } catch (err) {
      this.turnUser.delete(sessionId);
      this.hub.fail(streamId, String(err));
      throw err;
    }
  }

  /** Stop one operation, or everything open in the session when no id is named. */
  async abortTurn(sessionId: string, operationId?: string): Promise<boolean> {
    if (!sessionScopeOk(this.ctx, (name) => this.idFor(name), sessionId)) return false;
    // A child is a separate facet with its own operation, so the harness abort
    // above does not reach it. Its own `delegate` call rejects when the abort
    // lands, and the `finally` in `runChild` releases the cap slot and the facet.
    for (const name of this.childInFlight) {
      try {
        this.dynamicAgents.abort(Researcher, name, "the user stopped this turn");
      } catch {
        // A facet that already finished needs no abort. Nothing here can report a
        // stop more faithfully than the harness result below.
      }
    }
    // A continuation is a separate operation on the root's stream; stopping the
    // turn must stop it too, or Stop would leave the retry running unseen.
    const rootStream = operationId ? this.streamForOp(sessionId, operationId) : undefined;
    const extra = [...this.continuationOps.entries()].filter(
      ([, rec]) => rec.session === sessionId && (!rootStream || rec.rootStream === rootStream)
    );
    let stopped = false;
    try {
      stopped = await this.harness.session(sessionId).abort(operationId);
    } catch {
      stopped = false;
    }
    for (const [op] of extra) {
      try {
        if (await this.harness.session(sessionId).abort(op)) stopped = true;
      } catch {
        // A finished continuation needs no abort.
      }
    }
    if (stopped) {
      if (operationId) this.clearContinuation(this.rootOpFor(operationId));
      else for (const [, rec] of extra) this.clearContinuation(rec.rootOp);
    }
    return stopped;
  }

  /**
   * One turn, from whichever DO the caller addressed.
   *
   * Deterministic directives and the capability answer short-circuit BEFORE the
   * harness, exactly as they did before the cutover (Task 17's ruling: the harness
   * has no input kind that can originate an assistant tool part without a model
   * call). Everything else is one harness operation, whose result `replyFrom`
   * projects back onto `AgentReply`.
   */
  private async runTurn(
    content: string,
    tier: ChatTier | undefined,
    session: string
  ): Promise<AgentReply> {
    const chatTier: ChatTier = tier === "cheap" ? "cheap" : "primary";
    logMessage(this.db(), "user", content, chatTier);

    const direct = this.directKind(content);
    if (direct) return this.runDirect(content, direct, chatTier, session);

    // The harness owns the model's context. The user row above and the assistant
    // row `onHarnessTurnEnd` writes are the console's display projection only.
    this.stashTurn(session, { content, tier: chatTier });
    // The operation id is ours so the stream exists before the first chunk: an
    // observer that only reacts to run-start would race the async open().
    const opId = crypto.randomUUID();
    await this.hub.open(streamIdFor(session, opId), session);
    // No span on this lane, and that is not an oversight: `chat` is reached only from
    // the WebSocket handler and the alarm tick, and neither carries a request, so
    // nothing here could have answered the `X-Blip-Trace` gate (Task 38). Tracing it
    // unconditionally would span ordinary traffic the gate exists to leave alone.
    const result = await this.harness.session(session).prompt(content, {
      source: "server",
      operationId: opId,
    });
    return replyFrom(result);
  }

  /** The three deterministic turn kinds. Nothing here reaches the model. */
  private directKind(content: string): "exec" | "search" | "capabilities" | null {
    const directive = parseDirective(content);
    if (directive) return directive.kind;
    if (isCapabilityQuestion(content)) return "capabilities";
    return null;
  }

  /** Run a deterministic turn; the caller has already logged the user row. */
  private async runDirect(
    content: string,
    kind: "exec" | "search" | "capabilities",
    chatTier: ChatTier,
    session: string,
    onProgress?: ToolProgressSink
  ): Promise<AgentReply> {
    const sql = this.db();

    // Deterministic answer for capability questions: the free-tier model
    // ignores the system prompt here, and this is factual product copy. The whole
    // reply, safety line included, is generated from the one capability table
    // (Task 16) and served again by GET /api/capabilities (Task 29), so the chat
    // answer and the Tools tab cannot disagree.
    if (kind === "capabilities") {
      const reply = capabilityAnswer(EXPECTED_TOOLS);
      logMessage(sql, "assistant", reply, chatTier);
      await this.rememberGlobal("exchange", `User: ${content}\nAgent: ${reply}`, 1);
      return { reply, state: "idle", verb: "Ready" };
    }

    const arg = parseDirective(content)?.arg ?? "";

    // The human typed this command themselves, so it is already authorized and
    // bypasses the critical-effect approval gate that guards MODEL-emitted commands.
    if (kind === "exec") {
      const cmd = arg;
      const result = await this.runSandbox(cmd, session, onProgress);
      const output = formatExecResult(result);
      await this.rememberGlobal(
        "tool",
        `direct exec: ${cmd} -> ${result.ok ? "ok" : "fail"}`,
        2
      );
      const runs: ToolRun[] = [
        { name: "exec", cmd, output: output.slice(0, 4000), ok: result.ok },
      ];
      logMessage(sql, "assistant", output, chatTier, JSON.stringify(runs));
      // The same turn-end rule as the harness path: if the sandbox ran anything,
      // the turn owes a snapshot. A command that exited non-zero may still have
      // written files, so the gate is "reached the sandbox", not "succeeded".
      if (!result.error) {
        this.ctx.waitUntil(this.snapshotWorkspace(session).then(() => {}));
      }
      return {
        reply: output,
        state: result.ok ? "idle" : "error",
        verb: result.ok ? "Ran" : "Command failed",
        tools: runs,
      };
    }

    // Deterministic web search: "search: <query>" hits Parallel with no LLM
    // round trip, so search stays reliable even when the free model skips tools.
    const query = arg;
    let output: string;
    let ok = false;
    try {
      const results = await this.searchParallel(query);
      output = formatSearchResults(query, results, 5);
      ok = results.length > 0;
    } catch (err) {
      output = `web search error: ${err instanceof Error ? err.message : String(err)}`;
    }
    const runs: ToolRun[] = [
      { name: "lookup_online", cmd: query, output: output.slice(0, 4000), ok },
    ];
    logMessage(sql, "assistant", output, chatTier, JSON.stringify(runs));
    if (ok) await this.rememberGlobal("tool", `direct lookup_online: "${query}" -> ok`, 2);
    return {
      reply: output,
      state: ok ? "search" : "error",
      verb: ok ? "Searched the web" : "Search failed",
      tools: runs,
    };
  }

  /**
   * Run a deterministic turn into its operation stream: a live widget for the
   * exec/search arm, a text frame for the capability answer, then `done`. The
   * frame shapes are the same ones the harness path emits, so the console needs
   * no branch for which kind of turn produced them.
   */
  private async streamDirect(
    content: string,
    kind: "exec" | "search" | "capabilities",
    tier: ChatTier,
    session: string,
    streamId: string
  ): Promise<void> {
    const toolCallId = crypto.randomUUID();
    const tool = kind === "exec" ? "exec" : kind === "search" ? "lookup_online" : null;
    const input = parseDirective(content)?.arg ?? "";
    try {
      if (tool) {
        const widget = TOOL_WIDGET[tool] ?? { label: "Tool", state: "code" };
        this.hub.write(streamId, {
          t: "tool-start",
          id: toolCallId,
          name: tool,
          label: widget.label,
          state: widget.state,
          input,
        });
        this.hub.write(streamId, {
          t: "tool-progress",
          id: toolCallId,
          phase: kind === "exec" ? "running" : "searching",
          message: kind === "exec" ? "Running command" : "Searching the web",
          fraction: null,
        });
      } else {
        this.hub.write(streamId, { t: "state", state: "think", verb: "Thinking" });
      }
      const onProgress: ToolProgressSink = (p) => {
        this.hub.write(streamId, {
          t: "tool-progress",
          id: toolCallId,
          phase: p.phase,
          message: p.message,
          fraction: p.fraction,
          ...(p.tail === undefined ? {} : { tail: p.tail }),
        });
      };
      const reply = await this.runDirect(content, kind, tier, session, onProgress);
      if (tool) {
        const run = reply.tools?.[0];
        this.hub.write(streamId, {
          t: "tool-result",
          id: toolCallId,
          name: tool,
          ok: run?.ok ?? false,
          output: run?.output ?? reply.reply,
        });
      } else {
        this.hub.write(streamId, { t: "text", d: reply.reply });
      }
      if (reply.state) {
        this.hub.write(streamId, { t: "state", state: reply.state, verb: reply.verb ?? "" });
      }
      this.hub.finish(streamId, session, reply.reply);
    } catch (err) {
      this.hub.fail(streamId, String(err));
    }
  }

  private stashTurn(session: string, turn: StashedTurn): void {
    const queue = this.turnUser.get(session);
    if (queue) queue.push(turn);
    else this.turnUser.set(session, [turn]);
  }

  private takeTurn(session: string): StashedTurn | undefined {
    const queue = this.turnUser.get(session);
    if (!queue?.length) return undefined;
    const turn = queue.shift();
    if (queue.length === 0) this.turnUser.delete(session);
    return turn;
  }

  /** Cached global provider settings. A registry miss falls back to the env pin. */
  private async loadModelSettings(force = false): Promise<{
    providers: ModelProvider[];
    default: ModelDefault | null;
  }> {
    const cache = this.modelSettingsCache;
    if (!force && cache && Date.now() - cache.at < 5_000) {
      return { providers: cache.providers, default: cache.default };
    }
    try {
      const settings = await this.registryStub<RegistryStub>().modelSettings();
      this.modelSettingsCache = {
        at: Date.now(),
        providers: settings.providers,
        default: settings.default,
      };
      return settings;
    } catch {
      if (cache) return { providers: cache.providers, default: cache.default };
      return { providers: [], default: null };
    }
  }

  /** The concrete model for one provider choice, or undefined for the env pin. */
  private async modelForChoice(
    choice: { provider: string; model: string } | null
  ): Promise<ReturnType<typeof createPrimaryModel> | undefined> {
    if (!choice) return undefined;
    if (choice.provider === "deployment") {
      return createPrimaryModel(this.env, choice.model);
    }
    const settings = await this.loadModelSettings();
    const provider = settings.providers.find((item) => item.id === choice.provider);
    if (!provider) return undefined;
    return createCustomModel(provider, choice.model);
  }

  /**
   * `beforeTurn` runs before EVERY model call of a turn, so recall is per step,
   * not per turn. It never writes: reads only, and a failed hop degrades to no
   * memories rather than to a lost call.
   */
  private async beforeTurn(turn: ThinkTurnContext): Promise<ThinkTurnConfig> {
    let query = "";
    for (let i = turn.messages.length - 1; i >= 0; i--) {
      const message = turn.messages[i];
      if (message?.role !== "user") continue;
      query = messageText(message).slice(0, 120);
      break;
    }
    let memories: MemoryRow[] = [];
    try {
      memories = await this.recallGlobal(query, 8);
    } catch {
      memories = [];
    }
    if (memories.length === 0) {
      try {
        memories = await this.recallGlobal("", 8);
      } catch {
        memories = [];
      }
    }
    // The console's picker can put this session on another provider or model.
    // With no override, the global default wins; with neither, the env pin stays.
    const override = getModelOverride(this.db(), turn.session);
    const choice =
      override ??
      (await this.loadModelSettings()).default;
    const model = await this.modelForChoice(choice);
    const base = buildSystemPrompt(memories, capabilitiesText(EXPECTED_TOOLS), SANDBOX_HOME);
    // `continue()` has no user message, so the first step of a continuation is
    // told in the system prompt what its own last message failed to do.
    const system =
      turn.step === 0 && this.continuationNudgeOps.has(turn.operationId)
        ? `${base}\n\n${CONTINUATION_NUDGE}`
        : base;
    return {
      system,
      ...(model ? { model } : {}),
    };
  }

  /**
   * The display half of the turn. The harness owns model context; this writes
   * the text rows the console reads after a reload, one assistant row per
   * operation. Errors here are logged and ignored by the harness, so a display
   * gap can never cost the turn itself.
   */
  private async onHarnessTurnEnd(turn: ThinkTurnEndContext): Promise<void> {
    const stashed = this.takeTurn(turn.session);
    const pending = (turn.message?.parts ?? []).some(
      (part) => (part as ToolPartLike).state === "approval-requested"
    );
    const text =
      (turn.status === "done" ? turn.text?.trim() : "") ||
      messageText(turn.message) ||
      (pending
        ? "[waiting for approval]"
        : turn.status === "unanswered"
          ? `[stopped] ${turn.reason ?? "interrupted"}`
          : "[no text reply]");
    logMessage(this.db(), "assistant", text, stashed?.tier ?? "primary", persistedToolRuns(turn.message));
    // R45: the exchange is the memory a later session recalls, so it goes to
    // main. A continuation after an approval has no stashed user turn, so it
    // logs the display row only.
    if (stashed && turn.status === "done") {
      await this.rememberGlobal(
        "exchange",
        `User: ${stashed.content}\nAgent: ${text}`,
        2
      );
    }
    // Task 29: a turn that used the sandbox owes a snapshot, so the files it
    // built survive the VM being recycled without the model remembering to save.
    // Detached and non-fatal: the reply is already complete, the stream already
    // finished, and a save that fails is told by the next restore card and by the
    // over-limit row in the workspace store, never by holding this turn open.
    // A turn parked on an approval is not over, so it is not charged.
    if (!pending && turn.status === "done") {
      const touched = (turn.message?.parts ?? []).some((raw) => {
        const name = toolNameOf(raw as ToolPartLike);
        return name === "exec" || name === "save_workspace";
      });
      if (touched) {
        this.ctx.waitUntil(
          this.snapshotWorkspace(turn.session).then((r) => {
            if (!r.ok) {
              console.error(`turn-end snapshot failed for ${turn.session}: ${r.output}`);
            }
          })
        );
      }
    }
  }

  /**
   * Task 9: name a session from its first turn, off the reply path.
   *
   * `firstMessage` is the triggering turn's content, the string chat() was
   * called with, not a store read: recentMessages is oldest-first but covers
   * only the last rows, so it is not a by-session first-row reader.
   *
   * The fiber re-reads the registry before renaming, skips a title the user
   * already typed, and fails closed on a missing row. renameSession touches
   * only the title, never updated_at, so the sidebar's sort order does not move
   * behind the user. Every failure is caught here: title work must never reach
   * the reply path or become an unhandled rejection.
   */
  private startTitle(firstMessage: string, sessionId?: string): void {
    const id = sessionId ?? MAIN_DO_NAME;
    try {
      void this.runFiber("title", async () => {
        try {
          const registry = this.registryStub<TitleRegistry>();

          const before = await registry.get(id);
          if (!before || before.title !== PLACEHOLDER_TITLE) return;

          let title: string;
          try {
            const res = await fetchRouter(
              this.env,
              "/v1/chat/completions",
              {
                model: this.env.MODEL_CHEAP ?? DEFAULT_MODEL_CHEAP,
                messages: titleMessages(firstMessage),
                max_tokens: TITLE_MAX_TOKENS,
              },
              false,
              AbortSignal.timeout(20_000)
            );
            if (!res.ok) throw new Error(`router ${res.status}`);
            const data = (await res.json()) as {
              choices?: { message?: { content?: string } }[];
            };
            title = parseTitle(data.choices?.[0]?.message?.content ?? "", firstMessage);
          } catch {
            // The deterministic branch: the user's own words, no model attempt.
            title = parseTitle("", firstMessage);
          }
          if (!title) return;

          // P14: the user may have renamed while the cheap model was busy. Read
          // the row again and skip unless it is still the placeholder; a vanished
          // row is fail-closed, never a blind rename.
          const after = await registry.get(id);
          if (!after || after.title !== PLACEHOLDER_TITLE) return;
          await registry.rename(id, title);
        } catch {
          // A missing REGISTRY binding, an RPC failure or an unreadable response
          // degrades to no title work, exactly as recall degrades to [].
        }
      });
    } catch {
      // The SDK could not start a fiber; leave the placeholder untouched.
    }
  }

  /**
   * RPC: this session's own transcript (plan Task 7, R59). Transcripts shard per DO,
   * so a session reads its own history and `main` reads the whole pre-shard one. The
   * rows are `recentMessages`' own, newest-last, untouched: the route that serves
   * them must not reshape a MessageRow.
   */
  async messages(limit?: number): Promise<MessageRow[]> {
    return recentMessages(this.db(), limit ?? 50);
  }

  /** Vault RPC: store one base64 chunk. */
  async vaultPut(key: string, idx: number, total: number, dataB64: string): Promise<void> {
    vaultPutChunk(this.db(), key, idx, total, dataB64);
  }

  /** Vault RPC: read one base64 chunk (small payload; full pull RPC is capped). */
  async vaultChunk(key: string, idx: number): Promise<string | null> {
    const rows = this.db().exec<{ data: string }>(
      "SELECT data FROM vault_chunks WHERE vault_key = ? AND idx = ?",
      key,
      idx
    ).results;
    return rows[0]?.data ?? null;
  }

  /** Vault RPC: read full blob as bytes (null when missing). Small vaults only. */
  async vaultPull(key: string): Promise<Uint8Array | null> {
    return vaultGetBytes(this.db(), key);
  }

  /** Vault RPC: metadata for sync checks. */
  async vaultHealth(key: string): Promise<Record<string, unknown> | null> {
    return vaultMeta(this.db(), key) as Record<string, unknown> | null;
  }

  /** Vault RPC: delete all chunks for a key. */
  async vaultDelete(key: string): Promise<void> {
    vaultDeleteChunks(this.db(), key);
  }

  /**
   * Task query RPC for UI / API inspection. Named jobList (not `tasks`) because
   * the Agents SDK base class already owns a readonly `tasks` member.
   */
  async jobList(): Promise<TaskRow[]> {
    return listTasks(this.db(), 20);
  }

  /**
   * The human-in-the-loop gate, answered through the harness transcript.
   *
   * A parked call is identified by its string `toolCallId`; the `approvalId` the
   * harness matches on is read back off the pending part rather than guessed.
   * The parked operation has already settled when it parked, so this answer is a
   * NEW operation that continues the same assistant message. Returning a plain
   * object with string `state` (never an Error, never a class) is what survives
   * the DO RPC boundary.
   */
  async approveToolCall(
    sessionId: string,
    toolCallId: string,
    approved: boolean,
    reason?: string
  ): Promise<{
    ok: boolean;
    reply: string;
    state: string;
    output?: string;
    streamId?: string;
    operationId?: string;
  }> {
    if (!sessionScopeOk(this.ctx, (name) => this.idFor(name), sessionId)) {
      return {
        ok: false,
        reply: "This session cannot answer that approval.",
        state: "not_waiting",
      };
    }
    const session = this.harness.session(sessionId);
    let approvalId: string | null;
    try {
      approvalId = approvalIdOf(await session.messages(), toolCallId);
    } catch (err) {
      return {
        ok: false,
        reply: `Could not read the transcript: ${String(err)}`,
        state: "unanswered",
      };
    }
    if (!approvalId) {
      return {
        ok: false,
        reply: "That approval is no longer waiting.",
        state: "not_waiting",
      };
    }

    const claim = `${sessionId}:${approvalId}`;
    if (this.approving.has(claim)) {
      return {
        ok: false,
        reply: "That approval is already being answered.",
        state: "not_waiting",
      };
    }
    this.approving.add(claim);
    try {
      let receipt;
      try {
        receipt = await session.submit(
          { type: "approval", approvalId, approved, ...(reason ? { reason } : {}) },
          { autoContinue: true, source: "server" }
        );
      } catch (err) {
        return { ok: false, reply: String(err), state: "unanswered" };
      }

      // The continuation is a NEW harness operation, so its frames land on a new
      // stream. Opening it here (the hub would open it lazily on the first frame)
      // means the id we return on timeout is already a stream the console can
      // attach to, even when the model has not produced its first chunk yet.
      const streamId = streamIdFor(sessionId, receipt.operationId);
      try {
        await this.hub.open(streamId, sessionId);
      } catch {
        // A failed open is not a failed decision: the transcript still continues,
        // and the console's fallback is to reload it.
      }

      let outcome;
      try {
        outcome = await session.wait(receipt.operationId, AbortSignal.timeout(25_000));
      } catch (err) {
        const timedOut =
          err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        if (timedOut) {
          return {
            ok: true,
            reply: approved
              ? "Approved. The turn is continuing."
              : "Denied. The turn is continuing.",
            state: "queued",
            streamId,
            operationId: receipt.operationId,
          };
        }
        return { ok: false, reply: String(err), state: "unanswered" };
      }

      let messages: readonly UIMessage[] = [];
      try {
        messages = await session.messages();
      } catch {
        messages = [];
      }
      const projected = replyFrom({
        status: outcome.status,
        ...(outcome.status === "done" ? { text: outcome.text } : { reason: outcome.reason }),
        messages,
      });
      await this.rememberGlobal(
        "tool",
        `approval ${approved ? "granted" : "denied"} for ${toolCallId}`,
        3
      );
      const output = toolOutputOf(messages, toolCallId);
      return {
        ok: outcome.status === "done",
        reply: projected.reply,
        state: outcome.status,
        ...(output ? { output: output.slice(0, 4000) } : {}),
      };
    } finally {
      this.approving.delete(claim);
    }
  }

  /**
   * The approval a reloaded console cannot see. Read-only, session-scoped, and
   * `pending: null` when nothing is parked. It returns the same toolCallId
   * `approveToolCall` answers, so the console re-mounts the gate it lost when
   * the parked turn ended without a live receipt.
   */
  async pendingApproval(sessionId: string): Promise<PendingApprovalResult> {
    if (!sessionScopeOk(this.ctx, (name) => this.idFor(name), sessionId)) {
      return { ok: false, error: "This session cannot read that approval." };
    }
    try {
      const parked = parkedApproval(await this.harness.session(sessionId).messages());
      return {
        ok: true,
        pending: parked
          ? { toolCallId: parked.toolCallId, name: parked.name, cmd: parked.cmd }
          : null,
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /** WebSocket frames: {type:"chat"|"status", content, tier}. */
  async onMessage(
    connection: Connection,
    message: string | ArrayBuffer
  ): Promise<void> {
    if (typeof message !== "string") {
      connection.send(JSON.stringify({ error: "binary frames not supported" }));
      return;
    }
    let payload: ChatRequest & { type?: string };
    try {
      payload = JSON.parse(message) as ChatRequest & { type?: string };
    } catch {
      connection.send(JSON.stringify({ error: "invalid JSON" }));
      return;
    }
    const type = payload.type ?? "chat";
    if (type === "status") {
      connection.send(JSON.stringify({ type: "status", ok: true }));
      return;
    }
    if (type !== "chat" || typeof payload.content !== "string" || payload.content.length === 0) {
      connection.send(
        JSON.stringify({ error: 'expected {type:"chat", content, tier?}' })
      );
      return;
    }
    // Unscoped on purpose: the WebSocket still pins main, and ChatRequest carries no
    // session id. Task 22 owns the real fix, not this task.
    const reply = await this.chat(payload.content, payload.tier);
    connection.send(JSON.stringify({ type: "chat", ...reply }));
  }

  /**
   * Alarm tick: run due tasks, re-arm recurring ones, then re-schedule.
   *
   * R46 means this only ever runs on main, so every `remember` here stays LOCAL: on
   * main the local handle IS the global store (R45).
   */
  async onScheduledTask(_payload?: unknown): Promise<void> {
    const sql = this.db();
    const now = Date.now();
    for (const task of dueTasks(sql, now)) {
      remember(sql, "task", `Running scheduled task #${task.id}: ${task.title}`, 2);
      sql.exec(
        "UPDATE tasks SET status = 'running' WHERE id = ? AND status = 'pending'",
        task.id
      );
      try {
        const instructions = (task.payload && task.payload.trim()) || task.title;
        // A scheduled job belongs to main's own conversation, so it says so rather
        // than inheriting an unscoped undefined (Task 8, R46).
        const result = await this.chat(instructions, "cheap", MAIN_DO_NAME);
        remember(sql, "task-done", `Task #${task.id} (${task.title}) result: ${result.reply.slice(0, 800)}`, 3);
        // Task 33: the reply is in main's transcript, and a badge is the only way
        // anyone finds out without the console already open. Its own failure is not
        // the job's failure, so it is swallowed here rather than reaching the catch
        // below and recording a run that actually succeeded as failed.
        try {
          await this.registryStub<BadgeRegistry>().touch(MAIN_DO_NAME, { unreadDelta: 1 });
        } catch {
          // No REGISTRY binding or an RPC miss: the result is still stored.
        }
      } catch (err) {
        // A failed run must not kill a recurring schedule; record it and re-arm below.
        remember(sql, "error", `Task #${task.id} failed: ${String(err)}`, 3);
      }
      // Re-arm daily jobs in place (reuse the row). One-off jobs are retired the
      // moment they fire: the row is removed, and the result already lives in the
      // task-done memory and the assistant message chat() logged above.
      const daily = task.recurrence
        ? /^daily:(\d{1,2}):(\d{1,2})$/.exec(task.recurrence)
        : null;
      if (daily) {
        const nextDue = nextDailyDue(Number(daily[1]), Number(daily[2]), Date.now());
        sql.exec(
          "UPDATE tasks SET status = 'pending', due_at = ? WHERE id = ?",
          nextDue,
          task.id
        );
        remember(
          sql,
          "task",
          `Task #${task.id} (${task.title}) re-armed for ${new Date(nextDue).toISOString()}`,
          2
        );
      } else {
        sql.exec("DELETE FROM tasks WHERE id = ?", task.id);
        remember(sql, "task", `One-off #${task.id} (${task.title}) served; removed from board`, 1);
      }
    }
    await this.armTick();
  }

  private async armTick(): Promise<void> {
    try {
      const sql = this.db();
      // Soonest pending due time (null when nothing is queued). No literal "?" here.
      const raw = sql
        .exec<{ m: number | null }>(
          "SELECT MIN(due_at) AS m FROM tasks WHERE status = 'pending'"
        )
        .results[0]?.m;
      // This Agents SDK overload treats a numeric schedule() delay as SECONDS and a
      // Date as an absolute wake time. The old code passed milliseconds, which the SDK
      // read as seconds and pushed every wake ~1000x too far out. Pass a Date so the
      // unit can never be misread. The poll cadence stays clamped to [5s, 60s] so it
      // converges on the due time without storming the alarm.
      const now = Date.now();
      let wakeAt = now + 60_000;
      if (raw !== null && raw !== undefined) {
        const soonest = Number(raw);
        if (Number.isFinite(soonest)) {
          wakeAt = now + Math.min(60_000, Math.max(5_000, soonest - now));
        }
      }
      // ONE poll row, never one per arming. A one-shot schedule deduplicates only
      // when `idempotent: true`, and the SDK matches a reusable row on callback plus
      // payload and never on its time. On a dedup hit it keeps the EXISTING row and
      // discards the new time (`_insert` returns `existing.job` and only re-arms), so
      // the option is a duplicate guard for two arms that interleave, not a retimer:
      // the cancel loop below is what actually moves a wake earlier, which is why it
      // runs FIRST. Arming first and cancelling the other rows by id cannot retime,
      // because the arm would dedup onto the stale row and drop `wakeAt`. The
      // residual cost of cancel-first is one narrow window: if `schedule()` throws
      // after the cancels land, zero rows remain and the tick waits until main is
      // next instantiated (`onStart` re-arms) or the next insert re-arms. Bounded and
      // self-healing, and the alternative is the amplification below. Without the
      // option every arming event left a permanent cf_agents_jobs row behind:
      // onStart, each schedule_task, each tick that re-arms. The fired row is
      // deleted, the extra rows are not, so main ends up waking and running this
      // handler once per leftover row, every period, forever. This is the SDK's own
      // dedup idiom for a self-rescheduling alarm: list by callback, cancel them
      // all, arm once. Cancelling the row that is currently running is safe: the
      // queue deletes on outcome only `WHERE running = 1`, so a cleared row defers.
      for (const armed of (await this.listSchedules()).filter(
        (s) => s.callback === "onScheduledTask"
      )) {
        await this.cancelSchedule(armed.id);
      }
      await this.schedule(new Date(wakeAt), "onScheduledTask", undefined, { idempotent: true });
    } catch (err) {
      remember(this.db(), "error", `schedule failed: ${String(err)}`, 2);
    }
  }

  /** The four tool dependencies, each bound to the calling session (R40). */
  private toolDeps(session: string): ToolDeps {
    return {
      exec: (cmd, onProgress) => this.runSandbox(cmd, session, onProgress),
      search: (query) => this.searchParallel(query),
      schedule: (input) => this.scheduleJob(input),
      snapshot: () => this.snapshotWorkspace(session),
      delegate: (input) => this.runChild(input, session),
      progress: (toolCallId, p) => this.emitToolProgress(session, toolCallId, p),
    };
  }

  /**
   * Spawn or reuse one `Researcher` facet and return its report (Task 32).
   *
   * Three things are decided here rather than in `src/tools.ts`, and all three
   * need the Durable Object: the facet itself (`this.dynamicAgents`), the stream
   * the child reports onto (the operation this session is running right now), and
   * the cap. `src/child.ts` takes the routing from the caller and never derives it,
   * because a child that guessed an operation id would put its progress on the
   * wrong turn.
   */
  private async runChild(input: DelegateInput, session: string): Promise<string> {
    const operationId = this.currentOp.get(session);
    // No operation means nowhere to report onto. The child refuses the same
    // missing routing, so failing here keeps the reason in the parent's words.
    if (!input.parentCallId || !operationId) {
      throw new Error(
        `sub-agent ${input.name} was not started: this turn has no operation stream for its progress to land on.`
      );
    }
    if (this.childInFlight.has(input.name)) {
      throw new Error(
        `sub-agent ${input.name} is already working on that goal; its report is on the way`
      );
    }
    if (this.childInFlight.size >= MAX_CHILDREN_PER_SESSION) {
      throw new Error(childBusyRefusal(MAX_CHILDREN_PER_SESSION));
    }
    this.childInFlight.add(input.name);
    try {
      let child;
      try {
        child = await this.dynamicAgents.get(Researcher, input.name);
      } catch (err) {
        // A facet boot failure otherwise survives only as a tool-output string;
        // the stack is the difference between a routing bug and a platform limit.
        console.error(`facet get failed: ${err instanceof Error ? err.stack : String(err)}`);
        throw err;
      }
      const report = await child.research({
        goal: input.goal,
        focus: input.focus,
        parentSessionId: session,
        parentStreamId: this.streamForOp(session, operationId),
        parentCallId: input.parentCallId,
        trace: this.tracedOps.has(operationId),
      });
      return report.text;
    } catch (err) {
      console.error(`child run failed: ${err instanceof Error ? err.stack : String(err)}`);
      throw err;
    } finally {
      this.childInFlight.delete(input.name);
      // One facet per goal is a Durable Object, and nothing reuses it: the child
      // keeps no memory of the report it just gave, so leaving it idle forever is
      // a lease with no purpose. A failed delete must not turn a delivered report
      // into a failed tool call, so it is dropped rather than thrown.
      await this.dynamicAgents.delete(Researcher, input.name).catch(() => {});
    }
  }

  /**
   * One shell command in the E2B sandbox, through the shared client in
   * src/sandbox-client.ts. The two pieces of state the client cannot see, the
   * pointer row and this isolate's warm-lease set, are supplied here: a cold
   * sandbox is not free, so the wait gets a name before the call and its numbers
   * after.
   */
  private runSandbox(
    cmd: string,
    sessionId: string,
    onProgress?: ToolProgressSink
  ): Promise<ExecResult> {
    // The only signal the brain has that a rebuild is possible is its own pointer
    // row plus the fact that this isolate has not talked to this session's sandbox
    // yet. Guessing wrong costs one progress line, never a wrong file.
    const mayRebuild =
      !this.sandboxSeen.has(sessionId) && Boolean(getWorkspace(this.db(), sessionId)?.key);
    return runInSandbox(this.env, cmd, sessionId, {
      onProgress,
      mayRebuild,
      onWarm: () => this.sandboxSeen.add(sessionId),
    });
  }

  /** One Parallel Web Search call, through the shared client. */
  private searchParallel(query: string): Promise<SearchResult[]> {
    return searchParallelWeb(this.env, query);
  }

  /**
   * Schedule one job. The row and the alarm live on main (R46), so a session DO
   * hands both over through `enqueueGlobal`; a refused hop is reported as
   * unconfirmed rather than as a promise about the future.
   */
  private async scheduleJob(input: ScheduleInput): Promise<string> {
    const now = Date.now();
    let dueAt = now + 60_000;
    let recurrence: string | null = null;
    if (input.dailyAt && /^\d{1,2}:\d{2}$/.test(input.dailyAt)) {
      const [h, m] = input.dailyAt.split(":").map(Number);
      dueAt = nextDailyDue(h, m, now);
      recurrence = `daily:${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    } else if (typeof input.minutesFromNow === "number") {
      dueAt = now + Math.max(1, input.minutesFromNow) * 60_000;
    }
    const title = (input.title || "scheduled job").slice(0, 120);
    const instructions = (input.instructions || title).slice(0, 2000);

    // Refuse BEFORE storing anything. `Math.max(1, NaN)` is NaN, so a
    // `minutes_from_now: NaN` (or a value that overflows the largest Date this
    // platform can represent) used to pass straight through: `enqueueTask`
    // wrote the row, then `toISOString()` threw `RangeError: Invalid time
    // value` on the line after it, leaving a board entry with no date in the
    // reply that promised it. 8.64e15 is ECMAScript's max time value.
    if (!Number.isFinite(dueAt) || Math.abs(dueAt) > 8.64e15) {
      // Throw, not return: the harness records a thrown tool as `output-error`,
      // and src/reply.ts reports that as a failed card. A refusal string would
      // settle as output-available and render as a success.
      throw new Error(
        "schedule_task needs a due time this worker can represent. Retry with 'minutes_from_now' as a finite number of minutes, or 'daily_at' as HH:MM (24h UTC)."
      );
    }
    if (!(await this.enqueueGlobal(title, dueAt, instructions, recurrence))) {
      // Not a promise about the future either: the row can land on main and
      // only the reply be lost, so the honest statement is about what this
      // call did not get.
      throw new Error(
        "scheduling is unconfirmed: the main session did not answer this hop, so the job may or may not be queued. Ask the user to check the Tasks list, and only re-schedule if it is absent there. Do not report it as scheduled."
      );
    }
    const when = new Date(dueAt).toISOString();
    await this.rememberGlobal(
      "task",
      `Scheduled: ${title} at ${when}${recurrence ? ` (${recurrence})` : ""}`,
      2
    );
    // The job runs on main's DO, so it writes main's transcript and main's
    // sandbox lease, not this session's (R46). Say so rather than letting the
    // user look for the run in the chat they scheduled it from.
    return recurrence
      ? `Scheduled "${title}" daily at ${input.dailyAt} UTC. Next run ${when}. It runs autonomously with tool access, in the main session's conversation rather than this one.`
      : `Scheduled "${title}" at ${when}. It runs autonomously with tool access, in the main session's conversation rather than this one.`;
  }

  /**
   * The pointer row, in the shape the Files tab renders (Task 30).
   *
   * This is a read of this DO's own SQLite and never touches KV, which is the
   * whole point of the row: a KV `get` can be up to 60 s stale on the free plan,
   * and a Files tab that said "nothing saved" about a workspace saved seconds ago
   * would be believed.
   *
   * A row whose `key` is empty is reported as not saved. `recordTooLarge` inserts
   * exactly that shape when a session's first ever attempt is over the ceiling, so
   * `overLimit` can warn a user who has never had a snapshot, without the tab
   * claiming a restore is possible.
   */
  /**
   * Per-session model override for the console's picker. A scope failure returns
   * false instead of throwing, because a thrown value crossing a DO RPC arrives
   * in another realm where `instanceof` cannot match it (src/session-scope.ts).
   */
  async setModel(sessionId: string, model: string | null, provider?: string): Promise<boolean> {
    if (!sessionScopeOk(this.ctx, (name) => this.idFor(name), sessionId)) return false;
    setModelOverride(this.db(), sessionId, provider || "deployment", model);
    return true;
  }

  async modelChoice(sessionId: string): Promise<ModelChoiceInfo> {
    const pinned = this.env.MODEL_PRIMARY ?? DEFAULT_MODEL_PRIMARY;
    if (!sessionScopeOk(this.ctx, (name) => this.idFor(name), sessionId)) {
      return {
        model: null,
        provider: "deployment",
        pinned,
        defaultProvider: null,
        defaultModel: null,
      };
    }
    const override = getModelOverride(this.db(), sessionId);
    const settings = await this.loadModelSettings();
    return {
      model: override?.model ?? null,
      provider: override?.provider ?? settings.default?.provider ?? "deployment",
      pinned,
      defaultProvider: settings.default?.provider ?? null,
      defaultModel: settings.default?.model ?? null,
    };
  }

  async workspaceState(sessionId: string): Promise<WorkspaceState> {
    const empty: WorkspaceState = {
      saved: false,
      bytes: 0,
      files: 0,
      updatedAt: null,
      overLimit: null,
      limit: SNAPSHOT_LIMIT_BYTES,
    };
    if (!sessionScopeOk(this.ctx, (name) => this.idFor(name), sessionId)) return empty;
    const row = getWorkspace(this.db(), sessionId);
    if (!row) return empty;
    return {
      saved: Boolean(row.key),
      bytes: row.bytes,
      files: row.files,
      updatedAt: row.key ? row.updated_at : null,
      overLimit: row.over_limit_bytes,
      limit: SNAPSHOT_LIMIT_BYTES,
    };
  }

  /** Drop the pointer row, after the archives it names have been forgotten. */
  async clearWorkspace(sessionId: string): Promise<void> {
    if (!sessionScopeOk(this.ctx, (name) => this.idFor(name), sessionId)) return;
    clearWorkspaceRow(this.db(), sessionId);
  }

  /**
   * Delete one file from a session's workspace (Task 30).
   *
   * WHY THIS CANNOT BE A KV EDIT. The workspace is one gzip member list, not a
   * folder: to take one file out you have to unpack, drop it and re-pack, so the
   * only honest implementation is the running box. The command goes through
   * `runSandbox`, which boots a VM for this session and restores its archive if
   * one exists, so a delete on a cold session costs a boot and two KV writes and
   * is still the same answer. A bare `rm` with no `-r` and no `-f`: a directory is
   * not what this route lists, and a name that does not exist must fail loudly
   * rather than report a success for a file that was already gone.
   *
   * The path is guarded a second time here even though src/routes.ts refused the
   * bad shapes with a 400. A DO RPC can be called by anything that holds the stub,
   * and the argument ends up inside a shell command.
   */
  async deleteWorkspaceFile(
    sessionId: string,
    path: string
  ): Promise<WorkspaceDeleteResult> {
    const safe = safeWorkspacePath(path);
    if (!safe) {
      return { ok: false, output: "invalid file path", unavailable: false };
    }
    if (!this.env.SANDBOX) {
      return { ok: false, output: "sandbox not configured", unavailable: true };
    }
    const result = await this.runSandbox(`rm -- ${quoteShellArg(safe)}`, sessionId);
    if (!result.ok) {
      // exitCode null is runSandbox's own mark for an infrastructure failure, so
      // the route can answer 502 for it and 409 for a command that simply failed.
      const text = result.error || result.stderr || result.stdout;
      return {
        ok: false,
        output: text.trim().split("\n")[0] || "the sandbox returned nothing",
        unavailable: result.exitCode === null,
      };
    }
    const saved = await this.snapshotWorkspace(sessionId);
    return {
      // A delete that did not re-pack is not a delete: the next cold boot restores
      // the file from the archive that still names it.
      ok: saved.ok,
      output: saved.ok
        ? `Removed ${safe}. ${saved.output}`
        : `Removed ${safe}, but the new snapshot did not land: ${saved.output}`,
      unavailable: false,
    };
  }

  /**
   * Snapshot the calling session's workspace and record where it landed.
   *
   * The pointer row's digest goes out as `priorSha256`. When the tree has not
   * changed, the worker measures it, recognizes its own digest and writes nothing,
   * which is what keeps an automatic save at the end of every sandbox turn inside
   * the free plan's 1,000 KV writes a day.
   *
   * The body is the outcome, not the status code: 413 carries a real measurement
   * of a tree that is too big, and a 200 can carry `reason: "empty"`. Only a
   * reply that names a key and a digest may overwrite the pointer, so a failed
   * attempt leaves the address of the last good archive exactly where it was.
   *
   * No progress sink: the `save_workspace` tool already opens its card and closes
   * it with this string, so a second copy here would only repeat itself.
   */
  private async snapshotWorkspace(session: string): Promise<SnapshotResult> {
    if (!this.env.SANDBOX) {
      return { ok: false, output: "sandbox not configured" };
    }
    const sql = this.db();
    const prior = getWorkspace(sql, session);
    let data: SnapshotReply;
    try {
      const res = await this.env.SANDBOX.fetch(
        "https://zay-sandbox/workspace/snapshot",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.env.SBOX_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            sessionId: session,
            ...(prior?.sha256 ? { priorSha256: prior.sha256 } : {}),
          }),
        }
      );
      data = (await res.json()) as SnapshotReply;
    } catch {
      data = { ok: false, reason: "network" };
    }
    const output = formatSnapshotReply(data);
    const pointer = snapshotPointer(data);
    if (pointer) {
      recordSnapshot(sql, {
        session_id: session,
        ...pointer,
        // An unchanged tree did not land now, so the row keeps the moment the
        // copy that is really in storage was written. Only a fresh archive for
        // this same key may stamp a new time.
        updated_at:
          data.unchanged && prior?.key === pointer.key ? prior.updated_at : Date.now(),
        over_limit_bytes: null,
      });
    } else if (data.reason === "too_large") {
      recordTooLarge(sql, session, data.bytes ?? 0, Date.now());
    }
    return { ok: Boolean(data.ok), output };
  }
}
