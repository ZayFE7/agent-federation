import { Agent, type Connection } from "agents";
import type {
  AgentReply,
  ChatMessage,
  ChatRequest,
  ChatTier,
  Env,
  Tier,
  ToolRun,
} from "./types";
import { DEFAULT_MODEL_CHEAP, DEFAULT_MODEL_PRIMARY } from "./types";
import {
  dueTasks,
  enqueueTask,
  ensureSchema,
  listTasks,
  logMessage,
  recentMessages,
  recall,
  remember,
  type MemoryRow,
  type SqlHandle,
  type TaskRow,
} from "./memory";
import {
  ensureVaultSchema,
  vaultDelete as vaultDeleteChunks,
  vaultGetBytes,
  vaultMeta,
  vaultPutChunk,
} from "./vault";

/** Persona slot; swap this string per user later. */
export const DEFAULT_PERSONA =
  "You are Blip, a personal AI agent with a real Linux sandbox computer, persistent memory across sessions, and the ability to schedule background jobs. Be conversational, concise, and honest about what you cannot do.";

/**
 * Everything the model is allowed to do, as prompt text. Single source of truth
 * for the system prompt; the `tools` array in handleChat offers the matching
 * function schemas. Add a tool here and there (and to the UI's Tools tab) together.
 */
export const CAPABILITIES = [
  "- Persistent memory: you remember the user and prior conversations across sessions (recall happens automatically).",
  "- Linux sandbox: you can run shell commands and Python (exec tool) in a real Linux computer with internet access; important files can be snapshotted so they survive restarts (save_workspace tool).",
  "- Background jobs: you can schedule one-off or daily recurring jobs from plain text (schedule_task tool); they run autonomously with full tool access, e.g. every morning at 8.",
  "- A web console shows your live status and full replies.",
  "- NOT connected yet: email, calendar, messaging apps, a real web browser, payments. Say so honestly if asked; do not pretend these exist.",
  "Call a tool when the ask needs one. When no tool is needed, answer normally and conversationally: never reply with a plan you are not executing, and never invent activity the tools did not report.",
].join("\n");

/** Single place the system prompt is assembled (persona + capabilities + recalled memories). */
export function buildSystemPrompt(memories: MemoryRow[], persona: string): string {
  const memoryLines = memories.length
    ? memories.map((m) => `- (${m.kind}, importance ${m.importance}) ${m.content}`).join("\n")
    : "- (none yet)";
  return `${persona}\n\nCapabilities:\n${CAPABILITIES}\n\nKnown memories:\n${memoryLines}`;
}

interface RouterChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
  }>;
}

export class FederationAgent extends Agent<Env> {
  private schemaReady = false;

  /**
   * Adapt the Agents SDK's tagged-template this.sql(strings, ...values) into
   * the exec-style SqlHandle used by memory helpers. The SDK rebuilds the
   * query by joining string chunks with "?" for each value, so an exec-style
   * query must be split on its existing placeholders first.
   */
  private db(): SqlHandle {
    const sqlTag = this.sql.bind(this) as unknown as (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => unknown[];
    const handle: SqlHandle = {
      exec<T = Record<string, unknown>>(
        query: string,
        ...bindings: Array<string | number | null>
      ) {
        const parts = query.split("?");
        if (parts.length !== bindings.length + 1) {
          throw new Error(
            `SQL placeholder mismatch: ${parts.length - 1} placeholders, ${bindings.length} bindings`
          );
        }
        const strings = Object.assign(parts, { raw: [...parts] }) as unknown as TemplateStringsArray;
        const rows = sqlTag(strings, ...bindings) as T[];
        return { results: rows };
      },
    };
    if (!this.schemaReady) {
      ensureSchema(handle);
      ensureVaultSchema(handle);
      this.schemaReady = true;
    }
    return handle;
  }

  async onStart(): Promise<void> {
    this.db();
    await this.armTick();
  }

  /** RPC/HTTP entry used by the worker. */
  async chat(content: string, tier?: ChatTier): Promise<AgentReply> {
    try {
      return await this.handleChat(content, tier);
    } catch (err) {
      return { reply: "agent error: " + String(err) };
    }
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
    const reply = await this.handleChat(payload.content, payload.tier);
    connection.send(JSON.stringify({ type: "chat", ...reply }));
  }

  /** Alarm tick: log due tasks into memory and mark them running, then re-arm. */
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
        const result = await this.handleChat(instructions, "cheap");
        remember(sql, "task-done", `Task #${task.id} (${task.title}) result: ${result.reply.slice(0, 800)}`, 3);
        logMessage(sql, "assistant", `[scheduled] ${result.reply}`, "cheap");
      } catch (err) {
        remember(sql, "error", `Task #${task.id} failed: ${String(err)}`, 3);
      }
      sql.exec("UPDATE tasks SET status = 'done' WHERE id = ?", task.id);
    }
    await this.armTick();
  }

  private async armTick(): Promise<void> {
    try {
      await this.schedule("1 minute", "onScheduledTask");
    } catch (err) {
      remember(this.db(), "error", `schedule failed: ${String(err)}`, 2);
    }
  }

  private tierModel(tier: ChatTier): { tier: Tier; model: string } {
    if (tier === "cheap") {
      return { tier: "cheap", model: this.env.MODEL_CHEAP ?? DEFAULT_MODEL_CHEAP };
    }
    return { tier: "primary", model: this.env.MODEL_PRIMARY ?? DEFAULT_MODEL_PRIMARY };
  }

  private async handleChat(content: string, tier?: ChatTier): Promise<AgentReply> {
    const sql = this.db();
    const chatTier: ChatTier = tier === "cheap" ? "cheap" : "primary";
    const { tier: routerTier, model } = this.tierModel(chatTier);

    let memories: MemoryRow[] = [];
    try {
      memories = recall(sql, content.slice(0, 120), 8);
    } catch {
      memories = [];
    }
    if (memories.length === 0) {
      try {
        memories = recall(sql, "", 8);
      } catch {
        memories = [];
      }
    }
    const system = buildSystemPrompt(memories, DEFAULT_PERSONA);

    const history: ChatMessage[] = recentMessages(sql, 8)
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...history,
      { role: "user", content },
    ];
    logMessage(sql, "user", content, chatTier);

    // Deterministic answer for capability questions: the free-tier model
    // ignores the system prompt here, and this is factual product copy.
    if (/what can you do|what are you (able|capable)|your capabilit|help me with what/i.test(content)) {
      const reply =
        "Right now I can:\n" +
        "- chat and remember you across sessions (persistent memory)\n" +
        "- run shell commands and Python on a real Linux sandbox with internet (just ask, I'll execute)\n" +
        "- schedule one-off or daily background jobs from plain text, like \"every morning at 8 check X\"\n" +
        "- snapshot sandbox files so your work survives restarts\n" +
        "Not connected yet: email, calendar, messaging apps, a real browser, payments. Ask away, or tell me to run something.";
      logMessage(sql, "assistant", reply, chatTier);
      remember(sql, "exchange", `User: ${content}\nAgent: ${reply}`, 1);
      return { reply, state: "idle", verb: "Ready" };
    }


    const tools = [
      {
        type: "function",
        function: {
          name: "exec",
          description:
            "Run a shell command in the agent's Linux sandbox (python3, common CLI tools, internet). Use for files, code, downloads, data work, anything that needs a computer.",
          parameters: {
            type: "object",
            properties: {
              cmd: { type: "string", description: "The shell command to execute" },
            },
            required: ["cmd"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "schedule_task",
          description:
            "Schedule a recurring or one-off background job. Use when the user asks to be reminded, wants something done later, or on a schedule (e.g. every morning). The job runs autonomously with full tool access.",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short job name" },
              instructions: { type: "string", description: "What the agent should do when the job fires" },
              minutes_from_now: { type: "number", description: "Fire once this many minutes from now (one-off)" },
              daily_at: { type: "string", description: "HH:MM 24h UTC for a daily recurring job (overrides minutes_from_now)" },
            },
            required: ["title", "instructions"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "save_workspace",
          description:
            "Snapshot the sandbox /workspace directory into persistent storage so files survive sandbox restarts. Call after creating important files.",
          parameters: { type: "object", properties: {} },
        },
      },
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgs: any[] = messages;
    let finalText = "";
    /** Envelope tool cards for the UI: what the model actually called, in order. */
    const toolRuns: ToolRun[] = [];

    for (let round = 0; round < 4; round++) {
      let response: Response;
      try {
        response = await fetch(this.env.ROUTER_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.env.ROUTER_KEY}`,
            "X-Tier": routerTier,
          },
          body: JSON.stringify({ model, messages: msgs, tools }),
        });
      } catch (err) {
        remember(sql, "error", `Router fetch failed: ${String(err)}`, 3);
        return { reply: "Router unreachable. Try again shortly." };
      }
      if (!response.ok) {
        remember(sql, "error", `Router HTTP ${response.status}`, 3);
        return { reply: `Router returned ${response.status}.` };
      }
      const data = (await response.json()) as RouterChatResponse;
      const msg = data.choices?.[0]?.message;
      const toolCalls = msg?.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        finalText = msg?.content ?? "";
        break;
      }
      msgs.push({ role: "assistant", content: msg?.content ?? null, tool_calls: toolCalls });
      for (const tc of toolCalls) {
        let out = "";
        let runCmd = "";
        let runOk = false;
        try {
          const args = JSON.parse(tc.function.arguments || "{}") as {
            cmd?: string;
            title?: string;
            instructions?: string;
            minutes_from_now?: number;
            daily_at?: string;
          };
          if (tc.function.name === "schedule_task") {
            const now = Date.now();
            let dueAt = now + 60_000;
            if (args.daily_at && /^\d{1,2}:\d{2}$/.test(args.daily_at)) {
              const [h, m] = args.daily_at.split(":").map(Number);
              const next = new Date(now);
              next.setUTCHours(h, m, 0, 0);
              if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
              dueAt = next.getTime();
            } else if (typeof args.minutes_from_now === "number") {
              dueAt = now + Math.max(1, args.minutes_from_now) * 60_000;
            }
            const title = (args.title || "scheduled job").slice(0, 120);
            const instructions = (args.instructions || title).slice(0, 2000);
            enqueueTask(sql, title, dueAt, instructions);
            const when = new Date(dueAt).toISOString();
            out = `Scheduled "${title}" at ${when}. It will run autonomously with tool access.`;
            remember(sql, "task", `Scheduled: ${title} at ${when}`, 2);
            runCmd = title;
            runOk = true;
          } else if (tc.function.name === "save_workspace") {
            runCmd = "save_workspace";
            if (!this.env.SANDBOX) {
              out = "sandbox not configured";
            } else {
              const sres = await this.env.SANDBOX.fetch("https://zay-sandbox/workspace/snapshot", {
                method: "POST",
                headers: {
                  authorization: `Bearer ${this.env.SBOX_TOKEN}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ sessionId: "agent" }),
              });
              const sd = (await sres.json()) as Record<string, unknown>;
              runOk = sres.ok;
              out = sres.ok
                ? `Workspace saved: ${JSON.stringify(sd)}`
                : `snapshot error: ${JSON.stringify(sd).slice(0, 400)}`;
            }
          } else {
            const cmd = args.cmd || "true";
            runCmd = cmd;
            if (!this.env.SANDBOX) {
              out = "sandbox not configured";
            } else {
              const sres = await this.env.SANDBOX.fetch("https://zay-sandbox/run", {
                method: "POST",
                headers: {
                  authorization: `Bearer ${this.env.SBOX_TOKEN}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ cmd, sessionId: "agent" }),
              });
              const sd = (await sres.json()) as {
                stdout?: string;
                stderr?: string;
                exitCode?: number;
                error?: string;
              };
              runOk = sres.ok && sd.exitCode === 0;
              out = sres.ok
                ? `exit ${sd.exitCode}\nstdout:\n${(sd.stdout || "").slice(0, 4000)}\nstderr:\n${(sd.stderr || "").slice(0, 1500)}`
                : `sandbox error: ${(sd.error || JSON.stringify(sd)).slice(0, 600)}`;
              remember(sql, "tool", `exec: ${cmd} -> exit ${sd.exitCode ?? "?"}`, 2);
            }
          }
        } catch (e) {
          out = "tool error: " + String(e);
        }
        toolRuns.push({
          name: tc.function.name || "tool",
          cmd: runCmd,
          output: out.slice(0, 4000),
          ok: runOk,
        });
        msgs.push({ role: "tool", tool_call_id: tc.id, content: out });
      }
    }
    if (!finalText) finalText = "(hit the tool round limit; try a simpler ask)";

    logMessage(sql, "assistant", finalText, chatTier);
    remember(sql, "exchange", `User: ${content}\nAgent: ${finalText}`, 2);

    // Deterministic mascot state from what actually happened (no LLM decider).
    let state = "idle";
    let verb: string | undefined;
    const lower = (content + " " + finalText).toLowerCase();
    if (/error|failed|couldn't|cannot/.test(finalText.toLowerCase().slice(0, 200))) {
      state = "error";
      verb = "Hit a snag";
    } else if (toolRuns.some((t) => t.name === "exec")) {
      state = "code";
      verb = "Ran commands";
    } else if (/schedul|remind|every morning|every day|daily at|cron|recurring/.test(lower)) {
      state = "success";
      verb = "Job queued";
    } else if (/search|google|look up|find out|web/.test(lower)) {
      state = "search";
      verb = "Digging";
    } else if (/email|mail|inbox/.test(lower)) {
      state = "mail";
    } else if (/file|read|document/.test(lower)) {
      state = "read";
    } else if (/done|finished|complete|success/.test(lower)) {
      state = "success";
    }
    return { reply: finalText, state, verb, tools: toolRuns };
  }
}
