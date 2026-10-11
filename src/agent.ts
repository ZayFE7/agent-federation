import { Agent, type Connection } from "agents";
import type {
  AgentReply,
  ChatMessage,
  ChatRequest,
  ChatTier,
  Env,
  Tier,
} from "./types";
import { DEFAULT_MODEL_CHEAP, DEFAULT_MODEL_PRIMARY } from "./types";
import {
  dueTasks,
  ensureSchema,
  logMessage,
  recentMessages,
  recall,
  remember,
  type MemoryRow,
  type SqlHandle,
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
  "You are Federation, a personal AI assistant. Be concise, practical, and honest about uncertainty.";

/** Single place the system prompt is assembled (persona + recalled memories). */
export function buildSystemPrompt(memories: MemoryRow[], persona: string): string {
  const memoryLines = memories.length
    ? memories.map((m) => `- (${m.kind}, importance ${m.importance}) ${m.content}`).join("\n")
    : "- (none yet)";
  return `${persona}\n\nKnown memories:\n${memoryLines}`;
}

interface RouterChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
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
    return this.handleChat(content, tier);
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
    const { reply } = await this.handleChat(payload.content, payload.tier);
    connection.send(JSON.stringify({ type: "chat", reply }));
  }

  /** Alarm tick: log due tasks into memory and mark them running, then re-arm. */
  async onScheduledTask(_payload?: unknown): Promise<void> {
    const sql = this.db();
    const now = Date.now();
    for (const task of dueTasks(sql, now)) {
      remember(sql, "task", `Tick observed due task #${task.id}: ${task.title}`, 2);
      sql.exec(
        "UPDATE tasks SET status = 'running' WHERE id = ? AND status = 'pending'",
        task.id
      );
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

    let memories = recall(sql, content, 8);
    if (memories.length === 0) {
      memories = recall(sql, "", 8);
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

    let response: Response;
    try {
      response = await fetch(this.env.ROUTER_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.env.ROUTER_KEY}`,
          "X-Tier": routerTier,
        },
        body: JSON.stringify({ model, messages }),
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
    const reply = data.choices?.[0]?.message?.content ?? "";

    logMessage(sql, "assistant", reply, chatTier);
    remember(sql, "exchange", `User: ${content}\nAgent: ${reply}`, 2);

    return { reply };
  }
}
