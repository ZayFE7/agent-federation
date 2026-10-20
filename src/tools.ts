// The agent's tools as AI SDK definitions. Everything the model can DO lives
// here: one name, one schema, one description per tool, with the network and
// sandbox contracts injected as `ToolDeps` so an offline test can build the set
// without a DO, a sandbox, or a model.
//
// Recovery policy (agents 0.28.1 ThinkHarness): a tool may carry
// `recovery: "rerun"`; the harness strips the field before sending tools to the
// model, and after an interruption re-runs only tools that opted in. Absent
// means "report": the call is reported as uncertain, not retried. Only read-only
// tools opt in, because re-running a write (exec, schedule, snapshot) after an
// ambiguous interruption could duplicate its effect.

import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { EXPECTED_TOOLS, SANDBOX_HOME } from "./capabilities.ts";

/** One Parallel Web Search result, narrowed to the fields we surface to the model. */
export interface SearchResult {
  url?: string;
  title?: string;
  excerpts?: string[];
}

/** A finished sandbox command, before any formatting for the model. */
export interface ExecResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Infrastructure failure text (sandbox unreachable), not a command failure. */
  error?: string;
}

export interface SnapshotResult {
  ok: boolean;
  output: string;
}

export interface ScheduleInput {
  title: string;
  instructions: string;
  minutesFromNow?: number;
  dailyAt?: string;
}

export interface DelegateInput {
  task: string;
  context?: string;
}

/**
 * What the tools may call. The agent supplies the real implementations; tests
 * supply fakes. `exec`'s `onTail` is the seam a later streaming task uses to
 * forward sandbox output as it arrives.
 */
export interface ToolDeps {
  exec(cmd: string, onTail?: (line: string) => void): Promise<ExecResult>;
  search(query: string): Promise<SearchResult[]>;
  schedule(input: ScheduleInput): Promise<string>;
  snapshot(): Promise<SnapshotResult>;
  delegate?(input: DelegateInput): Promise<string>;
}

/** Slice to n chars and say so when truncated, so the model/user knows output was cut. */
function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)} [truncated ${s.length - n} chars]` : s;
}

/** One command result as text: exit code first, then both streams, clipped. */
export function formatExecResult(r: ExecResult): string {
  if (r.error) {
    return `sandbox infrastructure error; the command did not run: ${r.error.slice(0, 600)}`;
  }
  const head = r.ok
    ? "exit 0 (success)"
    : `command FAILED with exit ${r.exitCode ?? "unknown"}; read stderr before retrying`;
  return `${head}\nstdout:\n${clip(r.stdout || "", 4000)}\nstderr:\n${clip(r.stderr || "", 1500)}`;
}

/**
 * Render Parallel search results as compact text the model can reason over:
 * title + URL + one clipped excerpt per result. Caps the count (token budget)
 * and, when it caps, says so and tells the agent how to get more, rather than
 * silently dropping rows the model would assume were the complete answer.
 * Pure and exported so it can be unit-tested without hitting the network.
 */
export function formatSearchResults(
  query: string,
  results: SearchResult[],
  maxResults: number
): string {
  if (!results.length) {
    return `No web results for "${query}". Try a broader or differently-worded query.`;
  }
  const cap = Math.min(10, Math.max(1, Math.floor(maxResults) || 5));
  const shown = results.slice(0, cap);
  const body = shown
    .map((r, i) => {
      const title = (r.title || r.url || "untitled").trim();
      const excerpt = clip((r.excerpts || []).join(" ").replace(/\s+/g, " ").trim(), 400);
      return `${i + 1}. ${title}\n   ${r.url || "(no url)"}\n   ${excerpt || "(no excerpt)"}`;
    })
    .join("\n\n");
  const head = `Found ${results.length} web result(s) for "${query}"${
    results.length > shown.length ? ` (showing top ${shown.length})` : ""
  }:\n`;
  const tail =
    results.length > shown.length
      ? `\n\n[Showing ${shown.length} of ${results.length}. Raise max_results (up to 10) or narrow the query for more.]`
      : "";
  return head + body + tail;
}

function execTool(deps: ToolDeps) {
  return tool({
    description:
      `Run one shell command in the agent's persistent Linux sandbox: files, Python, downloads, data work, installs, anything that needs a real machine. Internet works. The working directory is ${SANDBOX_HOME}, and files there survive until the sandbox lease expires unless you snapshot them with save_workspace. Always gets back the exit code, stdout, and stderr; on a non-zero exit read stderr before retrying, and never report success for a command that failed. Prefer python3 for Python; write multi-line scripts to a file and run the file rather than inlining them. Long output is clipped with an explicit truncation notice.`,
    inputSchema: z.object({
      cmd: z
        .string()
        .describe(
          `A single shell command line, e.g. 'python3 solve.py' or 'ls -la ${SANDBOX_HOME}'. Runs in ${SANDBOX_HOME}; times out after 60s, so background long-running work.`
        ),
    }),
    execute: async ({ cmd }) => formatExecResult(await deps.exec(cmd)),
  });
}

function webSearchTool(deps: ToolDeps) {
  return Object.assign(
    tool({
      description:
        "Search the live web for current information: news, prices, documentation, events, or any fact that may have changed since your training or that you are not certain of. Returns titles, URLs, and text excerpts you can reason over and cite. Defaults to 5 results and returns at most 10; when results are truncated the output says so, and you should raise max_results or narrow the query to see more. Prefer this over guessing whenever the user asks about something current, specific, or external.",
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "A specific search phrase describing what to find. Example: 'Cloudflare Workers free tier daily request limit 2026'."
          ),
        max_results: z
          .number()
          .optional()
          .describe("How many results to return, 1 to 10. Defaults to 5."),
      }),
      execute: async ({ query, max_results }) => {
        const results = await deps.search(query);
        return formatSearchResults(query, results, max_results ?? 5);
      },
    }),
    { recovery: "rerun" as const }
  );
}

function scheduleTool(deps: ToolDeps) {
  return tool({
    description:
      "Schedule a recurring or one-off background job. Use when the user asks to be reminded, wants something done later, or on a schedule (such as every morning). The job runs autonomously with full tool access in the main session's conversation, so say where it will appear. Give exactly one of minutes_from_now (one-off) or daily_at (daily); daily_at wins if both are present.",
    inputSchema: z.object({
      title: z.string().describe("Short job name. Example: 'morning inbox check'."),
      instructions: z
        .string()
        .describe(
          "What the agent should do when the job fires. Example: 'Fetch example.com and report the top headline.'"
        ),
      minutes_from_now: z
        .number()
        .optional()
        .describe("Fire once this many minutes from now. Example: 30."),
      daily_at: z
        .string()
        .optional()
        .describe(
          "HH:MM in 24h UTC for a daily recurring job; overrides minutes_from_now. Example: '08:00'."
        ),
    }),
    execute: async ({ title, instructions, minutes_from_now, daily_at }) =>
      deps.schedule({
        title,
        instructions,
        minutesFromNow: minutes_from_now,
        dailyAt: daily_at,
      }),
  });
}

function saveWorkspaceTool(deps: ToolDeps) {
  return tool({
    description:
      `Snapshot the sandbox ${SANDBOX_HOME} directory into persistent storage so files survive a sandbox restart. Nothing is snapshotted automatically: call this yourself after creating important files.`,
    inputSchema: z.object({}),
    execute: async () => {
      const r = await deps.snapshot();
      return r.output;
    },
  });
}

/**
 * Build the tool set. `names` defaults to EXPECTED_TOOLS, so the wired set and
 * the capability table cannot drift; a child agent can be given a subset later.
 */
export function buildTools(
  deps: ToolDeps,
  names: readonly string[] = EXPECTED_TOOLS
): ToolSet {
  const builders: Record<string, (d: ToolDeps) => ToolSet[string]> = {
    exec: execTool,
    web_search: webSearchTool,
    schedule_task: scheduleTool,
    save_workspace: saveWorkspaceTool,
  };
  const tools: ToolSet = {};
  for (const name of names) {
    const build = builders[name];
    if (build) tools[name] = build(deps);
  }
  return tools;
}
