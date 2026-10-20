// Shared contract types for the federation agent worker and Durable Object.
// This module stays type-import-only so a dependency-free consumer (src/routes.ts)
// can read it, and so an offline test can assert on it as text.

import type { MessageRow } from "./memory";
import type { SessionRow } from "./registry-store";

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
  /** Tool function name, e.g. "exec" | "web_search" | "schedule_task" | "save_workspace". */
  name: string;
  /** What was invoked: the shell command, or the job title for schedule_task. */
  cmd: string;
  /** Captured stdout/stderr (or the scheduler's confirmation line). */
  output: string;
  /** Whether the invocation reported success. */
  ok: boolean;
}

/** Response shape for POST /api/message and the DO chat method. */
export interface AgentReply {
  reply: string;
  /** Deterministic mascot state (replaces the flaky LLM decider). */
  state?: string;
  /** Short capsule verb matching the state. */
  verb?: string;
  /** Tool cards the UI renders; empty when the model only talked. */
  tools?: ToolRun[];
  /** Set when a high-risk command was held for human approval instead of run. */
  pending?: { id: number; cmd: string };
  /** Current ordered plan checklist, when the agent decomposed the task. */
  plan?: Array<{ ord: number; title: string; status: string }>;
}

/** Inbound body for POST /api/message and WebSocket {type:"chat"}. */
export interface ChatRequest {
  content: string;
  tier?: ChatTier;
}

/**
 * Minimal RPC surface of FederationAgent used over the DO stub.
 *
 * Lifted out of src/index.ts, where it was unexported (R39): src/routes.ts is
 * dependency-free by rule, so the shapes it addresses DOs with have to live
 * here. Task 8 widens `chat` to take the session id; nothing else may restate
 * this interface.
 *
 * `messages` is Task 7's addition (R59): the transcript of one session, read from
 * that session's own DO. It returns MessageRow, the store's row shape with
 * `created_at` included, not UIMessage and not a {role, content} summary of one.
 */
export interface AgentStub {
  chat(content: string, tier?: ChatTier): Promise<AgentReply>;
  messages(limit?: number): Promise<MessageRow[]>;
  jobList(): Promise<unknown[]>;
  planState(): Promise<{ plan: unknown[]; pending: unknown }>;
  approveAction(
    id: number,
    approve: boolean
  ): Promise<{ ok: boolean; reply: string; state: string; output?: string }>;
  vaultPut(key: string, idx: number, total: number, dataB64: string): Promise<void>;
  vaultPull(key: string): Promise<Uint8Array | null>;
  vaultChunk(key: string, idx: number): Promise<string | null>;
  vaultHealth(key: string): Promise<Record<string, unknown> | null>;
  vaultDelete(key: string): Promise<void>;
}

/**
 * RPC surface of RegistryAgent (src/registry.ts), addressed through
 * env.REGISTRY.idFromName("registry"), the only instance ever created.
 *
 * The four write methods return void: the platform cursor exposes
 * rowsRead/rowsWritten and no per-statement affected-row count, so a boolean
 * here would be a fiction (R37, R58). The console re-lists after a rename or a
 * delete, so nothing consumes one.
 */
export interface RegistryStub {
  list(limit: number): Promise<SessionRow[]>;
  put(row: SessionRow): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
  touch(id: string, opts?: { unreadDelta?: number }): Promise<void>;
}

/**
 * Fallbacks when the wrangler vars are unset. They match the ids pinned in
 * `wrangler.jsonc` and measured by `tests/router-probe.mjs`
 * (docs/explorations/router-capability-probe.md): both tool-call, stream, and complete the
 * tool round trip on the local omniroute. The previous pair, `cf/@cf/qwen/qwen3.8-27b`, is not
 * routable in the `zay-router` Worker at all, so a worker launched without vars fell back to an
 * id that 404s on every call.
 */
export const DEFAULT_MODEL_PRIMARY = "gemini3.7flash";
export const DEFAULT_MODEL_CHEAP = "gemini3.8flash";

export interface Env {
  /** HTTPS URL of the Pipedream router workflow. */
  ROUTER_URL: string;
  /** Shared secret sent as Bearer to the router (router checks it if set). */
  ROUTER_KEY: string;
  /** Defaults below apply when these vars are unset in wrangler. */
  MODEL_PRIMARY?: string;
  MODEL_CHEAP?: string;
  /** Bearer token required by POST /api/message. */
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
}
