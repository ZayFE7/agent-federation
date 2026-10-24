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
import {
  EXPECTED_TOOLS,
  SANDBOX_HOME,
  SNAPSHOT_LIMIT_LABEL,
} from "./capabilities.ts";
import { formatLimit } from "./workspace-keys.ts";

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

/**
 * The sandbox worker's snapshot reply (deploy/sandbox-worker/workspace.ts,
 * `SnapshotResult`), narrowed to the fields a report needs. Kept as data so the
 * sentence the model and the widget show carries the numbers that were actually
 * measured rather than a dump of the JSON body.
 */
export interface SnapshotReply {
  ok: boolean;
  reason?: string;
  bytes?: number;
  files?: number;
  biggest?: string[];
  sha256?: string | null;
  key?: string | null;
  ms?: number;
  unchanged?: boolean;
}

/** The archive a reply points at. Null unless a usable archive exists. */
export interface SnapshotPointer {
  key: string;
  bytes: number;
  files: number;
  sha256: string;
}

/**
 * An archive is usable when the worker names the key it wrote and the digest it
 * stored. `unchanged` counts: the key names the copy already in storage, which is
 * the current truth even though no write happened.
 */
export function snapshotPointer(r: SnapshotReply): SnapshotPointer | null {
  if (!r.ok || typeof r.key !== "string" || !r.key) return null;
  if (typeof r.sha256 !== "string" || !r.sha256) return null;
  return { key: r.key, bytes: r.bytes ?? 0, files: r.files ?? 0, sha256: r.sha256 };
}

/**
 * One place the outcome becomes a sentence. A snapshot that silently did nothing
 * is the failure mode this exists to avoid, so each branch says what happened to
 * the bytes and, for an over-limit tree, which files to look at.
 */
export function formatSnapshotReply(r: SnapshotReply): string {
  const seconds = `${((r.ms ?? 0) / 1000).toFixed(1)} s`;
  const size = formatLimit(r.bytes ?? 0);
  const files = `${r.files ?? 0} file${r.files === 1 ? "" : "s"}`;
  if (r.reason === "too_large") {
    const names = (r.biggest ?? []).slice(0, 3).join(", ");
    return (
      `Not saved: the workspace is ${size} compressed, over the ${SNAPSHOT_LIMIT_LABEL} limit. ` +
      (names
        ? `Biggest files: ${names}. `
        : "") +
      `Delete or move what you do not need under ${SANDBOX_HOME}, then try again. ` +
      `Nothing was overwritten: the last snapshot that did fit is still in place.`
    );
  }
  if (r.unchanged) {
    return `Workspace unchanged since the last snapshot: ${files}, ${size}. Nothing was written.`;
  }
  if (r.reason === "empty") {
    return `Nothing to save: ${SANDBOX_HOME} has no files. The last snapshot, if any, is untouched.`;
  }
  if (!r.ok) {
    return `Snapshot failed${r.reason ? ` (${r.reason})` : ""}. Nothing was overwritten.`;
  }
  return `Workspace saved: ${size}, ${files}, in ${seconds} (${SNAPSHOT_LIMIT_LABEL} limit)`;
}

/**
 * The sandbox worker's restore reply (`RestoreResult`), narrowed to the fields a
 * progress frame reports.
 */
export interface RestoreReply {
  ok: boolean;
  restored: boolean;
  reason?: string;
  bytes?: number;
  files?: number;
  expectedBytes?: number;
  attempts?: number;
  ms?: number;
  legacy?: boolean;
}

/** Shown before a call that may have to rebuild a workspace, so the wait has a name. */
export const RESTORING_NOTICE = "Rebuilding your workspace";

/**
 * What a restore said when it landed. A session that was never saved has nothing
 * to report and returns the empty string, so a first-ever command does not show a
 * workspace card; every other outcome is named with its numbers, because "your
 * files are not here" needs a reason a person can act on.
 */
export function formatRestoreReply(r: RestoreReply): string {
  const seconds = `${((r.ms ?? 0) / 1000).toFixed(1)} s`;
  if (r.restored) {
    return `Workspace restored: ${formatLimit(r.bytes ?? 0)}, ${r.files ?? 0} file${
      r.files === 1 ? "" : "s"
    }, in ${seconds}`;
  }
  if (r.reason === "no_snapshot") return "";
  const tried = r.attempts && r.attempts > 1 ? ` after ${r.attempts} tries` : "";
  if (r.reason === "not_visible_yet") {
    return `The snapshot was not readable yet${tried}. The sandbox starts empty this time; the files arrive as soon as the copy replicates.`;
  }
  if (r.reason === "size_mismatch") {
    return `The snapshot read short: ${formatLimit(r.bytes ?? 0)} of the ${formatLimit(
      r.expectedBytes ?? 0
    )} recorded${tried}. It was not installed rather than half-installed.`;
  }
  if (r.reason === "extract_failed") {
    return `The snapshot would not unpack${
      r.bytes ? ` (${formatLimit(r.bytes)})` : ""
    }. The sandbox starts empty, and the saved copy is untouched.`;
  }
  return `Workspace not restored${r.reason ? ` (${r.reason})` : ""}. The sandbox starts empty.`;
}

export interface ScheduleInput {
  title: string;
  instructions: string;
  minutesFromNow?: number;
  dailyAt?: string;
}

export interface DelegateInput {
  /**
   * The sub-agent's identity, derived from the goal by `childNameFor`, never typed
   * by the model: it is what makes two delegations of the same goal land on one
   * child instead of two.
   */
  name: string;
  goal: string;
  focus?: string;
  /**
   * The parent's `delegate` tool-call id, which is the card the child's progress
   * folds onto (src/frames.ts, `childEventToParentFrames`). Empty means the caller
   * could not supply one and the child will refuse the run rather than guess.
   */
  parentCallId: string;
}

/**
 * How many sub-agents one session may have working at the same time. One number
 * for the tool description the model reads and the runner that refuses, so the
 * promise and the limit cannot drift apart.
 */
export const MAX_CHILDREN_PER_SESSION = 3;

/** What a child's report costs the parent's context, in characters. */
export const CHILD_REPORT_BYTES = 6000;

/** The refusal a capped fan-out hands back. Named here so it is one string. */
export function childBusyRefusal(max: number = MAX_CHILDREN_PER_SESSION): string {
  return `${max} sub-agents already running; wait or ask for fewer`;
}

const CHILD_NAME_PREFIX = "sub";

/** Stable base36 digest of a string. Not a security anything; a facet-name suffix. */
function digest(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * The goal, made into a Durable Object name: `sub-<words>-<digest>`.
 *
 * The words are for whoever is reading `wrangler` output or a facet list and wants
 * to know what this child is doing. The digest is for correctness: a slug of the
 * first 40 characters alone would put "summarize R2" and "summarize R2 and compare
 * S3" on the same child, and a child keeps the conversation it had, so the second
 * task would be answered out of the first one's context.
 *
 * `dynamicAgents.get` is idempotent per name, which is the whole reason the name
 * comes from the goal and not from a counter: fifty delegations of one goal are
 * fifty calls to one child.
 */
export function childNameFor(goal: string): string {
  const slug = (goal ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${CHILD_NAME_PREFIX}-${slug || "task"}-${digest(goal ?? "")}`;
}


/**
 * What a running tool reports while it works. `fraction` is null until the tool
 * can honestly measure progress; a tool's final report is always 1, because the
 * UI only settles a widget that reaches 1 (or receives the tool result).
 */
export interface ToolProgress {
  phase: string;
  message: string;
  fraction: number | null;
  tail?: string;
}

export type ToolProgressSink = (p: ToolProgress) => void;

/**
 * What the tools may call. The agent supplies the real implementations; tests
 * supply fakes. `progress` is the transport to the stream: each tool binds the
 * current `toolCallId` and forwards a ToolProgress, so the UI updates the card
 * that belongs to that exact call.
 */
export interface ToolDeps {
  exec(cmd: string, onProgress?: ToolProgressSink): Promise<ExecResult>;
  search(query: string, onProgress?: ToolProgressSink): Promise<SearchResult[]>;
  mcp?(server: string, tool: string, input: Record<string, unknown>): Promise<string>;
  skill?(name: string): Promise<{ name: string; description: string; body: string } | null>;
  schedule(input: ScheduleInput, onProgress?: ToolProgressSink): Promise<string>;
  snapshot(onProgress?: ToolProgressSink): Promise<SnapshotResult>;
  /**
   * Run one sub-agent and return its report. Absent for a child, and `delegate`
   * is then not built at all: a caller that has no way to spawn cannot be handed
   * the tool that would let it recurse.
   */
  delegate?(input: DelegateInput, onProgress?: ToolProgressSink): Promise<string>;
  progress?(toolCallId: string, p: ToolProgress): void;
}

/**
 * Bind the dep's progress transport to one tool call. Tools stay ignorant of
 * stream ids and frames; they only know the phase vocabulary.
 */
function progressSink(
  deps: ToolDeps,
  options: { toolCallId?: string } | undefined
): ToolProgressSink | undefined {
  const toolCallId = options?.toolCallId;
  if (!deps.progress || typeof toolCallId !== "string" || toolCallId.length === 0) {
    return undefined;
  }
  return (p) => deps.progress?.(toolCallId, p);
}

/** The last few lines of a command result, for the live widget's tail. */
function execTail(r: ExecResult): string {
  const text = r.error ?? [r.stdout, r.stderr].filter(Boolean).join("\n");
  const lines = text.trim().split("\n").filter(Boolean);
  return clip(lines.slice(-6).join("\n"), 400);
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
      `Run one shell command in the agent's persistent Linux sandbox: files, Python, downloads, data work, installs, anything that needs a real machine. Internet works. The working directory is ${SANDBOX_HOME}. Each chat session has its own sandbox, so another session's files are not reachable from here. Files you leave in ${SANDBOX_HOME} are snapshotted automatically at the end of a turn that used the sandbox and restored when the sandbox is next needed, so they survive the machine going away; you do not have to save them by hand. Always gets back the exit code, stdout, and stderr; on a non-zero exit read stderr before retrying, and never report success for a command that failed. Prefer python3 for Python; write multi-line scripts to a file and run the file rather than inlining them. Long output is clipped with an explicit truncation notice.`,
    inputSchema: z.object({
      cmd: z
        .string()
        .describe(
          `A single shell command line, e.g. 'python3 solve.py' or 'ls -la ${SANDBOX_HOME}'. Runs in ${SANDBOX_HOME}; times out after 60s, so background long-running work.`
        ),
    }),
    execute: async ({ cmd }, options) => {
      const onProgress = progressSink(deps, options);
      onProgress?.({ phase: "running", message: cmd, fraction: null });
      const result = await deps.exec(cmd, onProgress);
      // E2B's run endpoint returns at completion, so this is the first and only
      // output signal: the widget stays indeterminate until here, never fakes a
      // percentage.
      onProgress?.({ phase: "running", message: cmd, fraction: 1, tail: execTail(result) });
      return formatExecResult(result);
    },
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
      execute: async ({ query, max_results }, options) => {
        const onProgress = progressSink(deps, options);
        onProgress?.({ phase: "searching", message: query, fraction: null });
        const results = await deps.search(query, onProgress);
        onProgress?.({
          phase: "searching",
          message: query,
          fraction: 1,
          tail: `${results.length} result(s)`,
        });
        return formatSearchResults(query, results, max_results ?? 5);
      },
    }),
    { recovery: "rerun" as const }
  );
}

/**
 * One generic tool for every connected MCP server. The system prompt carries the
 * server/tool catalog; this keeps the model's tool list bounded no matter how
 * many MCP servers the owner connects.
 */
function mcpTool(deps: ToolDeps) {
  return tool({
    description:
      "Call one tool on a connected MCP server. The system prompt lists the connected servers and their tool names. Pass the server id, the tool name, and a JSON object of arguments. Use this for email, calendars, repositories, documents, and any other external service that is connected. Read-only tools run immediately; create, update, delete, send, publish and payment tools ask for approval.",
    inputSchema: z.object({
      server: z.string().describe("The MCP server id from the connected integrations list."),
      tool: z.string().describe("The MCP tool name from the connected integrations list."),
      arguments: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("The tool arguments as a JSON object. Use {} when the tool takes no arguments."),
    }),
    execute: async ({ server, tool: name, arguments: input }, options) => {
      const onProgress = progressSink(deps, options);
      onProgress?.({ phase: "mcp", message: `${server}/${name}`, fraction: null });
      if (!deps.mcp) return "No MCP connections are available in this session.";
      return deps.mcp(server, name, input ?? {});
    },
  });
}

/**
 * Load one installed skill. Skills are progressive disclosure: the system prompt
 * carries names and descriptions, and this call brings the full instructions in
 * only when the task needs them.
 */
function skillTool(deps: ToolDeps) {
  return tool({
    description:
      "Load one installed skill by name. The system prompt lists the installed skills and what they do. Use this when a skill matches the request, or when the user writes /skill-name. Follow the returned instructions. Arguments are optional and are passed as text to the skill.",
    inputSchema: z.object({
      name: z.string().describe("The skill name from the installed skills list."),
      arguments: z
        .string()
        .optional()
        .describe("Optional arguments to apply while following the skill."),
    }),
    execute: async ({ name, arguments: args }, options) => {
      const onProgress = progressSink(deps, options);
      onProgress?.({ phase: "skill", message: name, fraction: null });
      if (!deps.skill) return "No skills are available in this session.";
      const skill = await deps.skill(name);
      if (!skill) return `No skill named "${name}" is installed. Check the installed skills list.`;
      return [
        `Skill: ${skill.name}`,
        skill.description,
        args ? `Arguments: ${args}` : "",
        "",
        skill.body,
      ]
        .filter((line) => line !== "")
        .join("\n");
    },
  });
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
    execute: async ({ title, instructions, minutes_from_now, daily_at }, options) => {
      const onProgress = progressSink(deps, options);
      onProgress?.({ phase: "scheduling", message: title, fraction: null });
      const output = await deps.schedule(
        {
          title,
          instructions,
          minutesFromNow: minutes_from_now,
          dailyAt: daily_at,
        },
        onProgress
      );
      onProgress?.({
        phase: "scheduling",
        message: title,
        fraction: 1,
        tail: clip(output, 200),
      });
      return output;
    },
  });
}

function saveWorkspaceTool(deps: ToolDeps) {
  return tool({
    description:
      `Snapshot the sandbox ${SANDBOX_HOME} directory into persistent storage now, so the files survive the sandbox going away. The saved tree is capped at ${SNAPSHOT_LIMIT_LABEL} compressed: anything larger is not saved, and the output names the size and the biggest files so you can delete or move something and try again. A snapshot is also taken automatically when a turn that used the sandbox ends, so calling this is not how work gets kept: call it when you want a checkpoint at a specific moment, for instance right after building something the user asked for.`,
    inputSchema: z.object({}),
    execute: async (_input, options) => {
      const onProgress = progressSink(deps, options);
      const message = `snapshot ${SANDBOX_HOME}`;
      onProgress?.({ phase: "snapshotting", message, fraction: null });
      const r = await deps.snapshot(onProgress);
      onProgress?.({ phase: "snapshotting", message, fraction: 1, tail: clip(r.output, 200) });
      return r.output;
    },
  });
}

/**
 * Hand a self-contained task to a sub-agent (Task 32). The runner is a dep because
 * only the Durable Object can reach `this.dynamicAgents`; what is decided here is
 * the name, the cap on what the model was told, and the size of the report.
 */
function delegateTool(deps: ToolDeps, run: NonNullable<ToolDeps["delegate"]>) {
  return tool({
    description:
      `Give one self-contained task to a research sub-agent and get its written report back. A sub-agent has the shell and web search in this same session's sandbox, no memory of this conversation, no approval menu, and no way to ask the user, so the goal must carry everything it needs: what to find out and what the report should say. Use it for parts of a bigger ask that can be worked on independently, and ask for several in one reply to have them run at the same time (up to ${MAX_CHILDREN_PER_SESSION} at once; past that the call fails and says so rather than queueing). It cannot schedule jobs, save files, or spawn further agents, and a risky or irreversible command is blocked there instead of held, so keep that work for yourself. The report comes back capped at ${CHILD_REPORT_BYTES} characters.`,
    inputSchema: z.object({
      goal: z
        .string()
        .describe(
          "What to find out, written for a reader who cannot ask follow-ups and has not seen this conversation. Example: 'Find what Cloudflare Durable Objects SQLite storage is and report the two calls a facet uses.'"
        ),
      focus: z
        .string()
        .optional()
        .describe(
          "Optional narrowing: the angle, the format, or the limit. Example: 'only what is free on a worker plan, as five bullets.'"
        ),
    }),
    execute: async ({ goal, focus }, options) => {
      const name = childNameFor(goal);
      const onProgress = progressSink(deps, options);
      onProgress?.({
        phase: "delegating",
        message: `sub-agent ${name} starting`,
        fraction: null,
      });
      const report = await run(
        { name, goal, focus, parentCallId: options?.toolCallId ?? "" },
        onProgress
      );
      onProgress?.({
        phase: "delegating",
        message: `sub-agent ${name} reported`,
        fraction: 1,
        tail: clip(report, 200),
      });
      return `sub-agent ${name} reported:\n${clip(report, CHILD_REPORT_BYTES)}`;
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
    lookup_online: webSearchTool,
    schedule_task: scheduleTool,
    save_workspace: saveWorkspaceTool,
    mcp_call: mcpTool,
    skill: skillTool,
  };
  const tools: ToolSet = {};
  for (const name of names) {
    if (name === "delegate") {
      // Spawning is gated on a dep rather than on the name list, because a name
      // list is one forgotten filter away from letting a sub-agent spawn its own.
      const run = deps.delegate;
      if (typeof run === "function") tools.delegate = delegateTool(deps, run);
      continue;
    }
    const build = builders[name];
    if (build) tools[name] = build(deps);
  }
  return tools;
}
