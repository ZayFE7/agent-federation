// Per-turn tracing for the harness (plan Task 38).
//
// WHAT THE INSTALLED PACKAGE ACTUALLY DECLARES, and why this file is small.
// `agents@0.28.1` has no span API on its own surface:
//   - `Agent.observability` is `Observability`, one method, `emit(event)`
//     (agents/dist/agent-routing-BMvWTFEp.d.ts:4761 and index-YSKgfgg9.d.ts:804-810).
//   - `Agent._withAgentSpan` is private (agent-routing-BMvWTFEp.d.ts:4771), and it
//     builds spans through `cloudflareWorkers.tracing`, not through anything a
//     subclass can call.
//   - The type this plan named, `TraceOptions`, does not exist in the package: a grep
//     over node_modules finds that identifier only inside typescript's vendored
//     vscode-jsonrpc. So there is no per-call options type to shape a span against.
//   - The turn events the union does declare, `chat:turn:start` and `chat:turn:finish`
//     (index-YSKgfgg9.d.ts:459-481), have no emitter in 0.28.1: the string does not
//     appear in any file under agents/dist, and `harness/think/index.js` contains no
//     `_emit(` call at all. Assigning `this.observability` would therefore see every
//     lane except the one this task is about.
//
// What IS declared and usable is the platform span API: `tracing: Tracing` on the
// `cloudflare:workers` module (@cloudflare/workers-types/index.d.ts:16682), whose
// `startActiveSpan` hands back a `Span` with `isTraced`, `setAttributes`, `setStatus`,
// `recordException`, `end` (index.d.ts:4567-4614). That is where a per-call span with
// attributes comes from, and it is what the SDK itself uses, so this is the package's
// choice of shape rather than the plan's.
//
// Attributes are scalar only, the same rule the SDK applies when it projects
// per-call metadata onto a root span (agents/dist/observability/ai/index.js:175-189
// drops every non-scalar entry). `traceTagsFor` returns `Record<string, string>` for
// exactly that reason: both ids survive projection, and one production trace can then
// be found by `sessionId` and `operationId`.
//
// THE GATE HAS TWO HALVES, deliberately. `shouldTrace(request, env)` needs a Request.
// Inside a Durable Object an RPC turn has none: `AgentContext` IS `DurableObjectState`
// (agent-routing-BMvWTFEp.d.ts:6730), and the WebSocket a hibernated connection carries
// is a `Connection` with no request attached (capability-runner-BiVUtjqC.d.ts:29). So
// src/routes.ts reads the header and passes the answer as `submitTurn`'s fourth
// argument, and the DO asks `turnTracing(env, tracing)` for the deployment half. A
// sub-agent's turn inherits the flag through `ChildRun.trace`, because a facet is a
// DO of its own and nothing else reaches it. Lanes with no request at all (the
// WebSocket handler and the alarm tick, both through `chat`) are untraced on purpose:
// nobody could have opted in, and spanning them is exactly the cost the header half
// exists to avoid.
//
// NO RUNTIME IMPORTS (the plan's D6 limit): `agents` and `cloudflare:workers` are both
// unreadable from plain Node, so `Tracing` and `Span` are named as globals from the
// type config in tsconfig.json and every reference below is a type position only. That
// is what lets tests/observability.test.mjs run this module offline.

/** The header a client sets to ask for a trace of its own traffic. */
export const TRACE_HEADER = "X-Blip-Trace";

/** The only header value that means yes, so `X-Blip-Trace: 0` does not enable anything. */
export const TRACE_ON = "1";

/** One span per harness turn, named the same on every lane so a query can group them. */
export const TRACE_SPAN_NAME = "blip.turn";

/** The attribute key holding the session id, which is also the Durable Object name (R38). */
const SESSION_TAG = "blip.session.id";

/** The attribute key holding the operation id, the one id the console already streams on. */
const OPERATION_TAG = "blip.operation.id";

/** Which class ran the turn: main agent or sub-agent. */
const AGENT_TAG = "blip.agent";

/** The only env field this module reads. `Env` in src/types.ts satisfies it. */
export type TraceEnv = { AGENT_API_KEY?: string };

/** The span members this module touches, taken from the declared `Span`. */
export type TurnSpan = Pick<Span, "isTraced" | "setAttributes" | "setStatus" | "recordException" | "end">;

/** The span capability this module needs, taken from the declared `Tracing`. */
export type TurnTracing = Pick<Tracing, "startActiveSpan">;

/** One turn to run under a span. `tracing` absent means run it untraced. */
export type TurnTrace<T> = {
  tracing?: TurnTracing;
  agent: string;
  sessionId: string;
  operationId: string;
  run: () => Promise<T>;
};

/** The two ids a production trace is looked up by, as span attributes. */
export function traceTagsFor(sessionId: string, operationId: string): Record<string, string> {
  return { [SESSION_TAG]: sessionId, [OPERATION_TAG]: operationId };
}

/**
 * The deployment half of the gate. A worker with no key configured has no authenticated
 * traffic at all, so it must not start reporting on its own.
 */
export function traceConfigured(env?: TraceEnv): boolean {
  const key = env?.AGENT_API_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

/** Key configured AND this request asked for a trace. Ordinary traffic answers false. */
export function shouldTrace(request: Request, env?: TraceEnv): boolean {
  if (!traceConfigured(env)) return false;
  const header = request.headers.get(TRACE_HEADER);
  return header !== null && header.trim() === TRACE_ON;
}

/**
 * The capability a turn entry point should use: the platform's, or nothing at all when
 * the deployment is not configured to report. Both halves of the gate are one rule, so
 * a turn and a request cannot disagree about whether tracing is on.
 *
 * A turn hands no request in: it arrives through Durable Object RPC, whose context is
 * `DurableObjectState` with no headers in it, which is why `shouldTrace` is the caller's
 * job and this is the DO's.
 */
export function turnTracing(env: TraceEnv, capability: TurnTracing): TurnTracing | undefined {
  return traceConfigured(env) ? capability : undefined;
}

/**
 * Run one turn as one span. Returns the body's value and rethrows its error: a trace
 * must never change what a turn did, and an unended span never reports.
 */
export async function tracedTurn<T>(options: TurnTrace<T>): Promise<T> {
  const { tracing, agent, sessionId, operationId, run } = options;
  if (!tracing) return run();
  return tracing.startActiveSpan(TRACE_SPAN_NAME, (span: TurnSpan) =>
    settleTurn(span, agent, sessionId, operationId, run)
  );
}

/**
 * Writes attributes only when the runtime kept the span (`isTraced`), which is the
 * order the SDK uses too: a span the platform dropped costs one boolean read.
 *
 * The one log line is the evidence half of Task 38: a span is only worth opening if
 * somebody can read it, and the platform's trace viewer is not reachable from a
 * terminal, while `wrangler tail` is. It rides the same opt-in as the span, so
 * ordinary traffic writes nothing, and it carries ids and outcomes only, never the
 * turn's text or a key.
 */
async function settleTurn<T>(
  span: TurnSpan,
  agent: string,
  sessionId: string,
  operationId: string,
  run: () => Promise<T>
): Promise<T> {
  const traced = span.isTraced;
  if (traced) span.setAttributes({ ...traceTagsFor(sessionId, operationId), [AGENT_TAG]: agent });
  const head = `blip.turn session=${sessionId} operation=${operationId} agent=${agent} traced=${traced}`;
  try {
    const value = await run();
    if (traced) span.setStatus({ code: "ok" });
    console.log(`${head} status=ok`);
    return value;
  } catch (err) {
    const text = errText(err);
    if (traced) {
      span.setStatus({ code: "error", message: text });
      span.recordException(text);
    }
    console.log(`${head} status=error`);
    throw err;
  } finally {
    span.end();
  }
}

/** The reason string kept off a secret path: an Error's message, nothing else. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
