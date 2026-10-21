// The one place the brain talks to the sandbox worker's `/run` endpoint.
//
// It moved out of src/agent.ts when Task 31 gave a sub-agent the same `exec`
// tool: two copies of this contract is how a sandbox change lands in one agent
// and not the other. Same reason as the harness helpers: the call belongs to a
// module both Durable Object classes can import, not to a private method of one.
//
// Runtime imports are type-only plus ./tools.ts, so an offline test can load this.

import type { Env } from "./types";
import {
  RESTORING_NOTICE,
  formatRestoreReply,
  type ExecResult,
  type RestoreReply,
  type ToolProgressSink,
} from "./tools";

export interface SandboxRunOptions {
  /** The tool's live progress transport, if the caller has one. */
  onProgress?: ToolProgressSink;
  /**
   * True when this session has a saved tree that a cold sandbox would have to
   * unpack, so the wait gets named before the call. Guessing wrong costs one
   * progress line, never a wrong file.
   */
  mayRebuild?: boolean;
  /** Called when the worker answered 2xx, so the caller can mark the lease warm. */
  onWarm?: () => void;
}

/**
 * One shell command in the E2B sandbox. The session id keys the sandbox lease
 * (R40), so two chats never share one lease. Never throws: every failure comes
 * back as an ExecResult the formatter can report honestly.
 */
export async function runInSandbox(
  env: Env,
  cmd: string,
  sessionId: string,
  options: SandboxRunOptions = {}
): Promise<ExecResult> {
  const { onProgress, mayRebuild = false, onWarm } = options;
  if (!env.SANDBOX) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: "sandbox not configured",
    };
  }
  if (mayRebuild) {
    onProgress?.({ phase: "restoring", message: RESTORING_NOTICE, fraction: null });
  }
  try {
    const res = await env.SANDBOX.fetch("https://zay-sandbox/run", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SBOX_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ cmd, sessionId }),
    });
    const data = (await res.json()) as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      error?: string;
      restore?: RestoreReply | null;
    };
    if (res.ok) onWarm?.();
    if (data.restore) {
      const line = formatRestoreReply(data.restore);
      if (line) {
        onProgress?.({ phase: "restoring", message: line, fraction: 1 });
      }
    } else if (mayRebuild) {
      // The sandbox was still running, so nothing had to be rebuilt. Say so
      // rather than leaving "Rebuilding your workspace" as the last word.
      onProgress?.({
        phase: "restoring",
        message: "Sandbox was still running",
        fraction: 1,
      });
    }
    if (!res.ok) {
      return {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        error: `sandbox HTTP ${res.status}: ${(
          data.error || JSON.stringify(data)
        ).slice(0, 600)}`,
      };
    }
    const exitCode = typeof data.exitCode === "number" ? data.exitCode : null;
    return {
      ok: exitCode === 0,
      exitCode,
      stdout: typeof data.stdout === "string" ? data.stdout : "",
      stderr: typeof data.stderr === "string" ? data.stderr : "",
      ...(exitCode === null ? { error: data.error || "sandbox returned no exit code" } : {}),
    };
  } catch (err) {
    return { ok: false, exitCode: null, stdout: "", stderr: "", error: String(err) };
  }
}
