// The ThinkHarness options object, kept in its own module so an offline test can
// assert on OUR options without constructing the SDK class. Runtime imports stay
// small and Node-loadable: agents/sessions, ./approval.ts, ./provider.ts, and
// ./capabilities.ts. Types for the harness itself are import-type only.

import type { ToolSet } from "ai";
import type {
  ThinkErrorClass,
  ThinkHarnessHooks,
  ThinkHarnessOptions,
  ThinkSessionEvent,
  ThinkTurnEndContext,
} from "agents/harness/think";
import { createCompactFunction } from "agents/sessions";
import { createPrimaryModel } from "./provider.ts";
import { needsApproval } from "./approval.ts";
import { DEFAULT_PERSONA } from "./capabilities.ts";
import type { Env } from "./types.ts";

export interface HarnessConfigDeps {
  env: Env;
  /** One tool set for every session, or a factory that binds the session's sandbox. */
  tools: ToolSet | ((session: string) => ToolSet);
  /** RULING R70: construction-time, not PerSession. One harness, one budget. */
  maxSteps: number;
  classifyError: (e: unknown) => ThinkErrorClass;
  /** Consumed by harness.observe() in src/harness.ts, never a hook. */
  onEvent: (session: string, ev: ThinkSessionEvent) => void;
  onTurnEnd: (ctx: ThinkTurnEndContext) => Promise<void>;
  summarize: (text: string, sessionId?: string) => Promise<string>;
  /** Task 16: memory injection and the honest system prompt. */
  beforeTurn?: ThinkHarnessHooks["beforeTurn"];
  /**
   * Override the persona. The main agent leaves this unset and gets
   * DEFAULT_PERSONA, and its real prompt is assembled per turn in `beforeTurn`;
   * a child has no memory injection, so the persona it is built with is the
   * persona it runs with.
   */
  system?: string;
  /**
   * Override the approval gate. The main agent leaves this unset and a held call
   * reaches the console's approve card; a child has no reader that can answer one
   * (the approve RPC is addressed to a session DO, not a facet), so it passes a
   * function that never holds and blocks the risky call in its own tool instead.
   * Parking a call nobody can answer is how a sub-agent hangs.
   */
  approve?: (toolName: string, input: unknown) => boolean;
}

/**
 * R70: the one budget this build ships with. maxSteps is a single
 * construction-time number in agents 0.28.1, so two lanes would need two
 * harness instances, and two harness instances over one transcript table is the
 * silent double-writer this plan bans.
 */
export const MAX_STEPS_CHAT = 12;
/**
 * A child's budget (Task 31). Higher than the chat lane's because a research task
 * is search, then read, then search again, and it is bounded by the fact that a
 * child has two tools and no way to spawn another child.
 */
export const MAX_STEPS_CHILD = 15;
/** Declared, NOT wired: the value a future supporting API would use for a deep lane. */
export const MAX_STEPS_DEEP = 45;

/**
 * Explicit recovery (the SDK defaults are 10 attempts / 120 s). Two attempts
 * bounds a slow tunnel without multiplying spend; a 120 s silent stream is far
 * above the slowest first token measured through the tunnel, so a stall here is
 * a real interruption rather than a slow model.
 */
export const RECOVERY = Object.freeze({
  maxAttempts: 2,
  backoffMs: 1_000,
  stallTimeoutMs: 120_000,
});

/**
 * Compaction threshold in tokens. The router lane advertises a large context
 * window, but every prompt is billed end to end through a free tunnel, so older
 * history compacts well before the window; keepRecentTokens stays at the SDK
 * default (20_000).
 */
export const COMPACT_AFTER_TOKENS = 80_000;

export function harnessConfig(
  deps: HarnessConfigDeps
): ThinkHarnessOptions<ToolSet> {
  // One stateless model instance: the cheap lane cannot complete tool round
  // trips (tests/router-probe.mjs), so every lane uses the primary id until a
  // tool-capable cheap model is measured.
  const model = createPrimaryModel(deps.env);
  const toolsFor =
    typeof deps.tools === "function" ? deps.tools : () => deps.tools as ToolSet;
  return {
    model: () => model,
    system: () => deps.system ?? DEFAULT_PERSONA,
    tools: ({ session }) => toolsFor(session),
    maxSteps: deps.maxSteps,
    toolApproval: ({ toolName, input }) =>
      deps.approve ? deps.approve(toolName, input) : needsApproval(toolName, input),
    recovery: { ...RECOVERY },
    configureSession: (session, id) => {
      session
        .onCompaction(
          createCompactFunction({ summarize: (text) => deps.summarize(text, id) })
        )
        .compactAfter(COMPACT_AFTER_TOKENS);
    },
    hooks: {
      ...(deps.beforeTurn ? { beforeTurn: deps.beforeTurn } : {}),
      onTurnEnd: (ctx) => deps.onTurnEnd(ctx),
      classifyError: deps.classifyError,
    },
  };
}
