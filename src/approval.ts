// Which tool calls need a human before they run, and how to phrase the ask.
// Dependency-free (guardrails only) so an offline test can load it under plain
// Node; the transcript half of approval lives in the DO RPC (src/agent.ts),
// where the harness session and its parked parts actually exist.
//
// The harness calls this through `toolApproval` before every exec call, which
// means it must stay pure: no I/O, no state, no dependence on what ran before.

import { isRisky } from "./guardrails.ts";

function execCommand(input: unknown): unknown {
  if (input && typeof input === "object" && "cmd" in input) {
    return (input as { cmd?: unknown }).cmd;
  }
  return undefined;
}

/** The narrow transcript part this module can read without the SDK. */
interface PartLike {
  type?: string;
  toolName?: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  approval?: { id?: string };
}

interface MessageLike {
  parts?: readonly unknown[];
}

/** One parked call, enough for the console to re-mount its gate after a reload. */
export interface ParkedApproval {
  toolCallId: string;
  approvalId: string;
  name: string;
  cmd: string;
}

/**
 * The newest approval-requested tool part in a transcript. The console calls
 * this through a read-only route when it opens a session and has no live stream
 * receipt, so an approval that was parked before a reload is not lost.
 */
export function parkedApproval(messages: readonly MessageLike[]): ParkedApproval | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const raw of messages[i]?.parts ?? []) {
      const part = raw as PartLike;
      const type = part.type ?? "";
      const isTool = type === "dynamic-tool" || (type.startsWith("tool-") && type.length > 5);
      if (!isTool || part.state !== "approval-requested") continue;
      const toolCallId = part.toolCallId;
      const approvalId = part.approval?.id;
      if (typeof toolCallId !== "string" || !toolCallId) continue;
      if (typeof approvalId !== "string" || !approvalId) continue;
      const name =
        typeof part.toolName === "string" && part.toolName
          ? part.toolName
          : type.startsWith("tool-")
            ? type.slice(5)
            : type;
      const cmd = execCommand(part.input);
      return {
        toolCallId,
        approvalId,
        name,
        cmd: typeof cmd === "string" ? cmd : typeof part.input === "string" ? part.input : "",
      };
    }
  }
  return null;
}

/**
 * Fail closed on shape, not on ordinary code. Only `exec` runs a shell, so it
 * is the only tool a malformed input can turn into a runner that stringifies
 * garbage. `isRisky` now means "critical effect" (outward, payment, upload,
 * persistent workspace delete, VM destruction); ordinary sandbox code is free.
 */
export function needsApproval(toolName: string, input: unknown): boolean {
  if (toolName === "mcp_call") {
    if (!input || typeof input !== "object") return true;
    const tool = (input as { tool?: unknown }).tool;
    if (typeof tool !== "string" || !tool) return true;
    // Read-shaped MCP tools run free; anything that can change remote state asks.
    return !/^(get|list|search|read|fetch|find|query|describe|inspect|lookup|retrieve|count|download)/i.test(
      tool
    );
  }
  if (toolName !== "exec") return false;
  const cmd = execCommand(input);
  return typeof cmd !== "string" || isRisky(cmd);
}

/** One human sentence for the approval card, including what will run. */
export function approvalPromptFor(toolName: string, input: unknown): string {
  if (toolName === "mcp_call") {
    const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const server = typeof value.server === "string" ? value.server : "unknown server";
    const tool = typeof value.tool === "string" ? value.tool : "unknown tool";
    return `Call the ${tool} tool on ${server}?`;
  }
  if (toolName !== "exec") return `Run the ${toolName} tool?`;
  const cmd = execCommand(input);
  if (typeof cmd !== "string") {
    return "The agent asked to run a shell command without a valid command string.";
  }
  return `This action has real-world or persistent effects: ${cmd}`;
}
