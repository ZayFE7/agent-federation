// The one sub-agent class BLIP has (plan Task 31).
//
// WHAT IT IS. A dynamic-agent facet of a session's Durable Object: its own
// isolate and its own SQLite, supervised by and addressed under the parent that
// spawned it. The parent reaches it through `this.dynamicAgents.get(Researcher, name)`
// and calls `research()`, which runs one bounded harness turn and returns the
// report as text.
//
// WHAT IT DELIBERATELY IS NOT.
//   - Not recursive. Its tool set is CHILD_TOOL_NAMES, which has no `delegate`,
//     and that absence is pinned by tests/child.test.mjs against src/tools.ts
//     rather than asserted here as a comment.
//   - Not a session. It writes no registry row, no transcript row for the
//     console, and no workspace pointer, so the sidebar, `/messages` and the
//     Files tab cannot see it or be corrupted by it.
//   - Not approvable. The console's approve RPC is addressed to a session DO, so
//     a parked child call would wait forever. `approve: () => false` keeps the
//     harness from parking, and the exec dep below blocks a risky command
//     outright, which is fail-closed: the command does not run either way.
//   - Not able to stream on its own. Its events are folded into `tool-progress`
//     frames on the parent's operation stream, because the console can only open
//     the parent's stream (src/agent.ts, `ingestChildFrames`).
//
// NOT IMPORTABLE OFFLINE: like src/harness.ts, the `agents` runtime binds platform
// types at import. That is why the test for the recursion guard is about the tool
// list, not about this file.

import { Agent } from "agents";
import { tracing } from "cloudflare:workers";
import { classifyContextOverflow } from "agents/harness/think";
import type { ThinkHarness, ThinkSessionEvent } from "agents/harness/think";
import type { ToolSet } from "ai";
import {
  CHILD_PERSONA,
  CHILD_TOOL_NAMES,
  SANDBOX_HOME,
  capabilitiesText,
} from "./capabilities";
import { summarizeConversation } from "./compact";
import { childEventToParentFrames, type StreamFrame } from "./frames";
import { buildHarness } from "./harness";
import { MAX_STEPS_CHILD } from "./harness-config";
import { isRisky } from "./guardrails";
import { runInSandbox } from "./sandbox-client";
import { searchParallel } from "./search-client";
import { buildTools, type ToolDeps } from "./tools";
import type { Env } from "./types";
import { tracedTurn, turnTracing } from "./observability";

/**
 * One delegated task, exactly as the parent's `delegate` tool hands it over
 * (Task 32). The three routing fields are the parent's, never derived here: the
 * child cannot know the parent's operation id, and guessing would put progress on
 * the wrong turn.
 */
export interface ChildRun {
  goal: string;
  focus?: string;
  /** The parent's session id: it keys the sandbox lease (R40) and addresses the parent DO. */
  parentSessionId: string;
  /** The parent's operation stream, which is where this child's progress lands. */
  parentStreamId: string;
  /** The parent's `delegate` tool-call id, the card the child reports onto. */
  parentCallId: string;
  /**
   * Whether the parent's caller asked for a trace (Task 38). A child is a Durable
   * Object of its own with no request to read, so the opt-in arrives with the work
   * instead. Unset means no, which is what an ordinary send produces.
   */
  trace?: boolean;
}

/**
 * What `research()` answers with. There is no status field on purpose: anything
 * other than a finished turn with text throws, so a value here is always a report
 * and the parent never has to guess whether a string is an answer or a failure.
 */
export interface ChildReport {
  child: string;
  text: string;
}

function childSystem(): string {
  return [
    CHILD_PERSONA,
    `Your sandbox home is ${SANDBOX_HOME}, and it is the parent session's sandbox: files the main agent left there are readable, and files you write are its to keep or lose.`,
    "What you can do:",
    capabilitiesText(CHILD_TOOL_NAMES),
  ].join("\n\n");
}

export class Researcher extends Agent<Env> {
  private readonly harness: ThinkHarness<ToolSet>;
  /**
   * The run in flight. One at a time per child: a facet is a single DO, and the
   * parent gives each goal its own name, so two delegations never share one of
   * these. Keeping it a field rather than an argument is what lets the tool
   * factory bind the parent's session id without the model ever seeing it.
   */
  private run: ChildRun | null = null;
  /**
   * The forwarded-progress chain, kept serial so a child's tool result cannot
   * overtake its own tool start on the way to the parent's stream.
   */
  private chain: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.harness = buildHarness({
      env,
      system: childSystem(),
      tools: () => buildTools(this.toolDeps(), CHILD_TOOL_NAMES),
      maxSteps: MAX_STEPS_CHILD,
      classifyError: classifyContextOverflow,
      onEvent: (_session, ev) => this.forward(ev),
      onTurnEnd: async () => {},
      summarize: (text) => summarizeConversation(env, text),
      approve: () => false,
    });
    this.lifecycle.use(this.harness);
    // A facet cannot set a physical alarm, and the harness re-arms its wake
    // job on every submission. The turn is driven in-invoke by the harness's
    // own ensureDrive, so disabling the local alarm costs only crash recovery
    // for a bounded child the parent is awaiting anyway. Without this, every
    // delegate call fails with "Facets currently cannot set alarms."
    void this.lifecycle.disableAlarms().catch(() => {});
  }

  /**
   * One bounded research turn, and the report back to the parent.
   *
   * Throws when the child could not work, rather than returning a sentence that
   * looks like an answer: the harness records a thrown tool as `output-error`, so
   * the parent's model is told the sub-agent failed instead of reading a failure
   * as a finding.
   */
  async research(input: ChildRun): Promise<ChildReport> {
    const goal = typeof input?.goal === "string" ? input.goal.trim() : "";
    if (!goal) {
      throw new Error(
        "the sub-agent was handed no goal, so nothing ran. Call delegate with a goal written for a reader who cannot ask the user."
      );
    }
    if (!input.parentSessionId || !input.parentStreamId || !input.parentCallId) {
      throw new Error(
        "the sub-agent call is missing its parent routing (session, stream, or call id), so its progress would have nowhere to go."
      );
    }
    this.run = { ...input, goal };
    const focus =
      typeof input.focus === "string" && input.focus.trim()
        ? `\nFocus: ${input.focus.trim()}`
        : "";
    // A child is not a session, so its turn is keyed by the PARENT's session id: that
    // is the session a reader looks a delegated turn up under (Task 38). The operation
    // id is the child's own, which is what separates it from the parent's span.
    const sessionId = input.parentSessionId;
    const operationId = crypto.randomUUID();
    try {
      const result = await tracedTurn({
        tracing: input.trace ? turnTracing(this.env, tracing) : undefined,
        agent: "Researcher",
        sessionId,
        operationId,
        run: () =>
          this.harness
            .session(this.name)
            .prompt(`Task: ${goal}${focus}`, {
              source: "server",
              operationId,
            }),
      });
      if (result.status !== "done") {
        throw new Error(
          `the sub-agent ended ${result.status}${
            result.reason ? ` (${result.reason})` : ""
          } and has no report`
        );
      }
      const text = (result.text ?? "").trim();
      if (!text) {
        throw new Error(
          "the sub-agent finished with no text, so it found nothing it could put in a report."
        );
      }
      return { child: this.name, text };
    } catch (err) {
      // An RPC hop keeps only the message, so the facet logs its own stack.
      console.error(
        `Researcher research failed: ${err instanceof Error ? err.stack : String(err)}`
      );
      throw err;
    } finally {
      // The last frames are the ones a caller that returns immediately would
      // drop, so the hop chain is drained before the report goes back.
      await this.chain;
      this.run = null;
    }
  }

  /** Stop this child's running operation; the parent calls it when a turn is aborted. */
  async stop(operationId?: string): Promise<boolean> {
    try {
      return await this.harness.session(this.name).abort(operationId);
    } catch {
      return false;
    }
  }

  /**
   * Fold one harness event into frames on the parent's stream and hop them to
   * the parent's DO. The observer is synchronous, so the RPC is chained rather
   * than awaited; a failed hop costs a progress line, never the report.
   */
  private forward(ev: ThinkSessionEvent): void {
    const run = this.run;
    if (!run) return;
    const frames = childEventToParentFrames(ev, { id: run.parentCallId, name: this.name });
    if (frames.length === 0) return;
    const stub = this.parentStub(run.parentSessionId);
    this.chain = this.chain
      .then(() =>
        stub
          .ingestChildFrames(run.parentSessionId, run.parentStreamId, frames)
          .then(() => undefined)
      )
      .catch((err: unknown) => {
        console.error(`child progress hop failed: ${String(err)}`);
      });
  }

  /**
   * A stub for the parent's DO, typed as its RPC surface. A facet cannot reach
   * into the parent's isolate, and its own `Streams` rows are unreadable from the
   * parent's storage, so the frames have to be posted over the same hop shape
   * `mainStub()` in src/agent.ts uses for the global stores (R45).
   */
  private parentStub(sessionId: string): ParentSink {
    const id = this.env.FEDERATION_AGENT.idFromName(sessionId);
    return this.env.FEDERATION_AGENT.get(id) as unknown as ParentSink;
  }

  /**
   * The child's tools. `exec` runs in the PARENT session's sandbox, because that
   * is where the files the main agent is working on live; `lookup_online` is the
   * shared client. The other two deps exist only so a future addition to
   * CHILD_TOOL_NAMES fails loudly at the call rather than silently doing the
   * wrong thing: this class must never schedule a job or snapshot a workspace.
   */
  private toolDeps(): ToolDeps {
    const parentSession = () => {
      const run = this.run;
      if (!run) {
        throw new Error("this sub-agent has no task in flight, so it has no sandbox to use.");
      }
      return run.parentSessionId;
    };
    return {
      exec: (cmd, onProgress) => {
        // Fail closed without parking: no console path can answer a child's
        // approval, so the choice is block it or run it, and running an
        // irreversible command that a human would have held is not a choice.
        if (typeof cmd !== "string" || !cmd.trim() || isRisky(cmd)) {
          throw new Error(
            `blocked by the sub-agent's rules: a risky or empty command cannot be handed to an approval no one can answer. Name it in your report and let the main agent run it. Command: ${String(cmd).slice(0, 200)}`
          );
        }
        return runInSandbox(this.env, cmd, parentSession(), { onProgress });
      },
      search: (query) => searchParallel(this.env, query),
      schedule: () => {
        throw new Error(
          "a sub-agent cannot schedule jobs. Report what should be scheduled and let the main agent schedule it."
        );
      },
      snapshot: () => {
        throw new Error(
          "a sub-agent does not snapshot workspaces; the parent session's turn end is what saves its files."
        );
      },
    };
  }
}

/** The one parent RPC this class uses, kept as a local shape to avoid importing src/agent.ts. */
interface ParentSink {
  ingestChildFrames(
    sessionId: string,
    streamId: string,
    frames: StreamFrame[]
  ): Promise<void>;
}
