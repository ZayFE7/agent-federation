// Shared contract types for the federation agent worker and Durable Object.

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
}
