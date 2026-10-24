// Project a ThinkHarness prompt result back onto BLIP's AgentReply shape, so the
// worker route and the not-yet-streaming console keep working unchanged while
// the turn itself runs on the harness.
//
// Dependency-free apart from type imports: offline tests load this under plain
// Node with a hand-built transcript.

import type { AgentReply, ToolRun } from "./types.ts";

export interface UIPartLike {
  type?: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id?: string };
}

export interface UIMessageLike {
  role?: string;
  parts?: readonly UIPartLike[];
}

export interface PromptResultLike {
  status: string;
  text?: string;
  reason?: string;
  messages?: readonly UIMessageLike[];
}

/** The text parts of one message, in order, joined with newlines. */
export function messageText(message: UIMessageLike | undefined): string {
  if (!message?.parts) return "";
  return message.parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .trim();
}

function toolNameOf(part: UIPartLike): string | null {
  const type = part.type ?? "";
  if (type === "dynamic-tool") return part.toolName || null;
  if (type.startsWith("tool-") && type.length > 5) return type.slice(5);
  return null;
}

function inputRecord(part: UIPartLike): Record<string, unknown> {
  const input = part.input;
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function commandOf(name: string, part: UIPartLike): string {
  const input = inputRecord(part);
  for (const key of ["cmd", "query", "title", "task"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return name;
}

function outputOf(part: UIPartLike): string {
  if (typeof part.output === "string") return part.output;
  if (part.output === undefined || part.output === null) return "";
  try {
    return JSON.stringify(part.output);
  } catch {
    return String(part.output);
  }
}

function okOf(name: string, output: string, part: UIPartLike): boolean {
  if (part.state !== "output-available") return false;
  if (name === "exec" && /^(command FAILED|sandbox )/.test(output)) return false;
  return true;
}

/**
 * The slice of the transcript this operation wrote: everything after the last
 * user message. Without it a reply would carry every tool card the session ever
 * produced, because `prompt()` returns the whole active transcript.
 */
function turnMessages(messages: readonly UIMessageLike[]): UIMessageLike[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return messages.slice(i + 1);
  }
  return [...messages];
}

function runsOf(parts: readonly UIPartLike[]): ToolRun[] {
  const runs: ToolRun[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const name = toolNameOf(part);
    if (!name) continue;
    const id = part.toolCallId ?? "";
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const output = outputOf(part);
    runs.push({
      name,
      cmd: commandOf(name, part),
      output: output.slice(0, 4000),
      ok: okOf(name, output, part),
    });
  }
  return runs;
}

function pendingOf(
  parts: readonly UIPartLike[]
): AgentReply["pending"] | undefined {
  for (const part of parts) {
    const name = toolNameOf(part);
    if (!name || part.state !== "approval-requested") continue;
    return {
      toolCallId: part.toolCallId ?? "",
      name,
      cmd: commandOf(name, part),
    };
  }
  return undefined;
}

function ladder(
  runs: ToolRun[],
  pending: AgentReply["pending"],
  status: string
): { state: string; verb?: string } {
  if (pending) return { state: "approve", verb: "Needs approval" };
  if (status === "unanswered") return { state: "error", verb: "Stopped" };
  const names = runs.map((r) => r.name);
  if (runs.length > 0 && runs.every((r) => !r.ok)) {
    return { state: "error", verb: "Hit a snag" };
  }
  if (
    names.includes("lookup_online") ||
    names.includes("search_web") ||
    names.includes("web_search")
  ) {
    return { state: "search", verb: "Searched the web" };
  }
  if (names.includes("exec")) return { state: "code", verb: "Ran commands" };
  if (names.includes("schedule_task")) return { state: "success", verb: "Job queued" };
  if (names.includes("save_workspace")) return { state: "files", verb: "Saved workspace" };
  if (names.includes("delegate")) return { state: "think", verb: "Delegated" };
  return { state: "idle" };
}

/**
 * One prompt result as the console's reply envelope. The text comes from the
 * last assistant message; tool cards and the pending approval come from the
 * messages this operation wrote. An empty answer is reported as empty rather
 * than as "", because the console hides empty replies.
 */
export function replyFrom(result: PromptResultLike): AgentReply {
  const messages = result.messages ?? [];
  const turn = turnMessages(messages);
  const assistants = turn.filter((m) => m.role === "assistant");
  const last = assistants[assistants.length - 1];
  let reply = messageText(last);
  if (!reply && typeof result.text === "string") reply = result.text.trim();
  if (!reply) {
    reply =
      result.status === "unanswered"
        ? `The agent stopped before writing a reply${
            result.reason ? ` (${result.reason})` : ""
          }. Ask it to continue if you still need the answer.`
        : "The agent finished without producing a text reply. Ask it to summarize what it did.";
  }
  const parts = assistants.flatMap((m) => m.parts ?? []);
  const runs = runsOf(parts);
  const pending = pendingOf(parts);
  const { state, verb } = ladder(runs, pending, result.status);
  return {
    reply,
    state,
    verb,
    tools: runs.length > 0 ? runs : undefined,
    pending,
  };
}
