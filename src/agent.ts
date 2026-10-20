import { Agent, type Connection } from "agents";
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
  ToolRun,
  TurnReceipt,
  TurnRefusal,
} from "./types";
import { DEFAULT_MODEL_CHEAP } from "./types";
import {
  EXPECTED_TOOLS,
  SANDBOX_HOME,
  buildSystemPrompt,
  capabilityList,
  capabilitiesText,
} from "./capabilities";
import {
  dueTasks,
  enqueueTask,
  ensureSchema,
  listTasks,
  logMessage,
  nextDailyDue,
  recall,
  recentMessages,
  remember,
  type MemoryRow,
  type MessageRow,
  type SqlHandle,
  type TaskRow,
} from "./memory";
import { toSqlHandle, type SqlTag } from "./sql-handle";
import { MAIN_DO_NAME, assertSessionScope, sessionScopeOk } from "./session-scope";
import { PLACEHOLDER_TITLE } from "./registry-store";
import { parseTitle, titleMessages } from "./titles";
import {
  ensureVaultSchema,
  vaultDelete as vaultDeleteChunks,
  vaultGetBytes,
  vaultMeta,
  vaultPutChunk,
} from "./vault";
import { fetchRouter } from "./router";
import { parseDirective } from "./directives";
import { buildHarness } from "./harness";
import { MAX_STEPS_CHAT } from "./harness-config";
import { framesFromEvent, TOOL_WIDGET } from "./frames";
import { StreamHub, streamIdFor } from "./stream-hub";
import { messageText, replyFrom } from "./reply";
import {
  buildTools,
  formatExecResult,
  formatSearchResults,
  type ExecResult,
  type ScheduleInput,
  type SearchResult,
  type SnapshotResult,
  type ToolDeps,
  type ToolProgress,
} from "./tools";

/**
 * The two registry RPCs the title fiber calls (Task 9). A local shape rather
 * than RegistryStub because that interface is what src/routes.ts addresses;
 * this cast only has to describe the DO methods used here.
 */
interface TitleRegistry {
  get(id: string): Promise<{ title: string } | null>;
  rename(id: string, title: string): Promise<void>;
}

/** One stashed user turn, consumed by the matching onTurnEnd. */
interface StashedTurn {
  content: string;
  tier: ChatTier;
}

/** The narrow shape of a UIMessage part this file reads across the RPC boundary. */
interface ToolPartLike {
  type?: string;
  toolCallId?: string;
  state?: string;
  output?: unknown;
  errorText?: string;
  approval?: { id?: string };
}

function isToolPart(part: ToolPartLike): boolean {
  const type = part.type ?? "";
  return type === "dynamic-tool" || (type.startsWith("tool-") && type.length > 5);
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

export class FederationAgent extends Agent<Env> {
  private readonly harness: ThinkHarness<ToolSet>;
  private readonly streams: Streams;
  private readonly hub: StreamHub;
  private readonly turnUser = new Map<string, StashedTurn[]>();
  /** The running operation per session, so tool progress lands on its stream. */
  private readonly currentOp = new Map<string, string>();
  private schemaReady = false;

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
      summarize: (text) => this.summarize(text),
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
    if (frames.length > 0 && (ev.type === "chunk" || ev.type === "run-start")) {
      this.hub.feed(streamIdFor(session, ev.operationId), session, frames);
    }
    if (ev.type !== "operation") return;
    if (this.currentOp.get(session) === ev.status.operationId) {
      this.currentOp.delete(session);
    }
    const streamId = streamIdFor(session, ev.status.operationId);
    if (ev.status.status === "done") {
      this.hub.finish(streamId, session, ev.status.text ?? "");
    } else if (ev.status.status === "unanswered") {
      this.hub.fail(streamId, ev.status.reason ?? "operation ended without an answer");
    }
  }

  /** A tool's live progress, addressed to its call id on the operation's stream. */
  private emitToolProgress(session: string, toolCallId: string, p: ToolProgress): void {
    const operationId = this.currentOp.get(session);
    if (!operationId) return;
    this.hub.feed(streamIdFor(session, operationId), session, [
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
    sessionId: string
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
    try {
      const receipt = await this.harness.session(sessionId).submit(content, {
        source: "server",
        operationId,
      });
      return { operationId: receipt.operationId, streamId };
    } catch (err) {
      this.turnUser.delete(sessionId);
      this.hub.fail(streamId, String(err));
      throw err;
    }
  }

  /**
   * The legacy wait path (Task 23 keeps `/api/message` working as submit then
   * wait): resolve one submitted operation into the same AgentReply shape
   * `chat()` returns. The transcript is read after settlement because a
   * `wait()` result carries only the text, and `replyFrom` projects tool runs
   * from the assistant message.
   */
  async waitTurn(sessionId: string, operationId: string): Promise<AgentReply> {
    if (!sessionScopeOk(this.ctx, (name) => this.idFor(name), sessionId)) {
      return { reply: "", code: "invalid_session" };
    }
    try {
      const session = this.harness.session(sessionId);
      const outcome = await session.wait(operationId);
      let messages: readonly UIMessage[] = [];
      try {
        messages = await session.messages();
      } catch {
        messages = [];
      }
      return replyFrom({
        status: outcome.status,
        ...(outcome.status === "done" ? { text: outcome.text } : { reason: outcome.reason }),
        messages,
      });
    } catch (err) {
      return { reply: "agent error: " + String(err) };
    }
  }

  /** Stop one operation, or everything open in the session when no id is named. */
  async abortTurn(sessionId: string, operationId?: string): Promise<boolean> {
    if (!sessionScopeOk(this.ctx, (name) => this.idFor(name), sessionId)) return false;
    try {
      return await this.harness.session(sessionId).abort(operationId);
    } catch {
      return false;
    }
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
    if (/what can you do|what are you (able|capable)|your capabilit|help me with what/i.test(content)) {
      return "capabilities";
    }
    return null;
  }

  /** Run a deterministic turn; the caller has already logged the user row. */
  private async runDirect(
    content: string,
    kind: "exec" | "search" | "capabilities",
    chatTier: ChatTier,
    session: string
  ): Promise<AgentReply> {
    const sql = this.db();

    // Deterministic answer for capability questions: the free-tier model
    // ignores the system prompt here, and this is factual product copy. Every
    // line comes from the one capability table (Task 16).
    if (kind === "capabilities") {
      const wired = capabilitiesText(EXPECTED_TOOLS);
      const missing = capabilityList(EXPECTED_TOOLS)
        .filter((c) => !c.wired)
        .map((c) => c.label.toLowerCase())
        .join(", ");
      const reply =
        "Right now I can:\n" +
        wired +
        (missing ? `\n\nNot connected yet: ${missing}.` : "") +
        "\n\nSafety: high-risk commands (destructive, irreversible, outward-facing, or spending money) are held for your explicit approval before they run.";
      logMessage(sql, "assistant", reply, chatTier);
      await this.rememberGlobal("exchange", `User: ${content}\nAgent: ${reply}`, 1);
      return { reply, state: "idle", verb: "Ready" };
    }

    const arg = parseDirective(content)?.arg ?? "";

    // The human typed this command themselves, so it is already authorized and
    // bypasses the isRisky approval gate that guards MODEL-emitted commands.
    if (kind === "exec") {
      const cmd = arg;
      const result = await this.runSandbox(cmd, session);
      const output = formatExecResult(result);
      await this.rememberGlobal(
        "tool",
        `direct exec: ${cmd} -> ${result.ok ? "ok" : "fail"}`,
        2
      );
      logMessage(sql, "assistant", output, chatTier);
      const runs: ToolRun[] = [
        { name: "exec", cmd, output: output.slice(0, 4000), ok: result.ok },
      ];
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
    logMessage(sql, "assistant", output, chatTier);
    if (ok) await this.rememberGlobal("tool", `direct web_search: "${query}" -> ok`, 2);
    const runs: ToolRun[] = [
      { name: "web_search", cmd: query, output: output.slice(0, 4000), ok },
    ];
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
    const tool = kind === "exec" ? "exec" : kind === "search" ? "web_search" : null;
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
      const reply = await this.runDirect(content, kind, tier, session);
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
    return {
      system: buildSystemPrompt(memories, capabilitiesText(EXPECTED_TOOLS), SANDBOX_HOME),
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
    logMessage(this.db(), "assistant", text, stashed?.tier ?? "primary");
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
  }

  /** One compaction summary through the non-tool cheap lane. */
  private async summarize(text: string): Promise<string> {
    const res = await fetchRouter(
      this.env,
      "/v1/chat/completions",
      {
        model: this.env.MODEL_CHEAP ?? DEFAULT_MODEL_CHEAP,
        messages: [
          {
            role: "system",
            content:
              "Summarize this conversation for an AI agent's own memory. Keep facts, decisions, file paths, commands that worked, and open tasks. Be compact and concrete.",
          },
          { role: "user", content: text },
        ],
        max_tokens: 800,
      },
      false,
      AbortSignal.timeout(30_000)
    );
    if (!res.ok) throw new Error(`router ${res.status}`);
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const summary = (data.choices?.[0]?.message?.content ?? "").trim();
    if (!summary) throw new Error("empty compaction summary");
    return summary;
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
          const registry = this.env.REGISTRY.get(
            this.env.REGISTRY.idFromName("registry")
          ) as unknown as TitleRegistry;

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
                max_tokens: 60,
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
  ): Promise<{ ok: boolean; reply: string; state: string; output?: string }> {
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

    let receipt;
    try {
      receipt = await session.submit(
        { type: "approval", approvalId, approved, ...(reason ? { reason } : {}) },
        { autoContinue: true, source: "server" }
      );
    } catch (err) {
      return { ok: false, reply: String(err), state: "unanswered" };
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
      exec: (cmd) => this.runSandbox(cmd, session),
      search: (query) => this.searchParallel(query),
      schedule: (input) => this.scheduleJob(input),
      snapshot: () => this.snapshotWorkspace(session),
      progress: (toolCallId, p) => this.emitToolProgress(session, toolCallId, p),
    };
  }

  /**
   * One shell command in the E2B sandbox. The session id keys the sandbox lease
   * (R40), so two chats never share one lease. Never throws: every failure comes
   * back as an ExecResult the formatter can report honestly.
   */
  private async runSandbox(cmd: string, sessionId: string): Promise<ExecResult> {
    if (!this.env.SANDBOX) {
      return {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        error: "sandbox not configured",
      };
    }
    try {
      const res = await this.env.SANDBOX.fetch("https://zay-sandbox/run", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.env.SBOX_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ cmd, sessionId }),
      });
      const data = (await res.json()) as {
        stdout?: string;
        stderr?: string;
        exitCode?: number;
        error?: string;
      };
      if (!res.ok) {
        return {
          ok: false,
          exitCode: null,
          stdout: "",
          stderr: "",
          error: `sandbox HTTP ${res.status}: ${(
            data.error || JSON.stringify(data)
          ).slice(0, 600)}`,
        };
      }
      const exitCode = typeof data.exitCode === "number" ? data.exitCode : null;
      return {
        ok: exitCode === 0,
        exitCode,
        stdout: typeof data.stdout === "string" ? data.stdout : "",
        stderr: typeof data.stderr === "string" ? data.stderr : "",
        ...(exitCode === null
          ? { error: data.error || "sandbox returned no exit code" }
          : {}),
      };
    } catch (err) {
      return { ok: false, exitCode: null, stdout: "", stderr: "", error: String(err) };
    }
  }

  /**
   * One Parallel Web Search call. Throws with actionable text on every failure
   * mode so the harness records an error the model can read; the caller that
   * needs a text reply (the "search:" directive) catches it itself.
   */
  private async searchParallel(query: string): Promise<SearchResult[]> {
    const q = (query || "").trim();
    if (!this.env.PARALLEL_API_KEY) {
      throw new Error(
        "web search is not configured on this worker (no PARALLEL_API_KEY). Tell the user search is unavailable."
      );
    }
    if (!q) {
      throw new Error(
        "web_search needs a non-empty query. Retry with what you want to find."
      );
    }
    let res: Response;
    try {
      res = await fetch("https://api.parallel.ai/v1/search", {
        method: "POST",
        headers: {
          "x-api-key": this.env.PARALLEL_API_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({ objective: q, search_queries: [q] }),
        // Search must fail fast, not hang the tool loop or the UI.
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new Error(`web search request failed: ${String(err)}`);
    }
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 300);
      throw new Error(
        `web search failed (HTTP ${res.status}): ${errText}. The Parallel key may lack the Search product; tell the user.`
      );
    }
    const data = (await res.json()) as { results?: SearchResult[] };
    return data.results || [];
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

  /** Snapshot the calling session's sandbox home so its files survive a restart. */
  private async snapshotWorkspace(session: string): Promise<SnapshotResult> {
    if (!this.env.SANDBOX) {
      return { ok: false, output: "sandbox not configured" };
    }
    try {
      const res = await this.env.SANDBOX.fetch(
        "https://zay-sandbox/workspace/snapshot",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.env.SBOX_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ sessionId: session }),
        }
      );
      const data = (await res.json()) as Record<string, unknown>;
      return res.ok
        ? { ok: true, output: `Workspace saved: ${JSON.stringify(data)}` }
        : { ok: false, output: `snapshot error: ${JSON.stringify(data).slice(0, 400)}` };
    } catch (err) {
      return { ok: false, output: `snapshot error: ${String(err)}` };
    }
  }
}
