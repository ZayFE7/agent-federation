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
  /** Tool function name, e.g. "exec" | "schedule_task" | "save_workspace". */
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
}

/** Inbound body for POST /api/message and WebSocket {type:"chat"}. */
export interface ChatRequest {
  content: string;
  tier?: ChatTier;
}

export const DEFAULT_MODEL_PRIMARY = "meta/muse-spark-1.3";
export const DEFAULT_MODEL_CHEAP = "meta/muse-spark-1.3-contributor";

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
  /** Durable Object binding for FederationAgent (wrangler name: FEDERATION_AGENT). */
  FEDERATION_AGENT: DurableObjectNamespace;
}
