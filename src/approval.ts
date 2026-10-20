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

/**
 * Fail closed on shape. Only `exec` runs a shell, so it is the only tool a
 * malformed or dangerous input can turn into blast radius; a missing or
 * non-string `cmd` is treated as needing approval rather than being sent to a
 * runner that might stringify it.
 */
export function needsApproval(toolName: string, input: unknown): boolean {
  if (toolName !== "exec") return false;
  const cmd = execCommand(input);
  return typeof cmd !== "string" || isRisky(cmd);
}

/** One human sentence for the approval card, including what will run. */
export function approvalPromptFor(toolName: string, input: unknown): string {
  if (toolName !== "exec") return `Run the ${toolName} tool?`;
  const cmd = execCommand(input);
  if (typeof cmd !== "string") {
    return "The agent asked to run a shell command without a valid command string.";
  }
  return `Run this command in the sandbox: ${cmd}`;
}
