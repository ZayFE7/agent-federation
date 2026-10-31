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

export interface SandboxFileWrite {
  path: string;
  contentBase64: string;
}

export interface SandboxListedFile {
  path: string;
  bytes: number;
  mtime: number;
}

/** Read one workspace file as bytes, or null when it is absent. */
export async function readSandboxBytes(
  env: Env,
  sessionId: string,
  path: string
): Promise<Uint8Array | null> {
  if (!env.SANDBOX) return null;
  try {
    const url = new URL("https://zay-sandbox/workspace/read");
    url.searchParams.set("sessionId", sessionId);
    url.searchParams.set("path", path);
    const res = await env.SANDBOX.fetch(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${env.SBOX_TOKEN}` },
    });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Write one workspace file with an exact path, including spaces or unicode. */
export async function putSandboxFile(
  env: Env,
  sessionId: string,
  path: string,
  contentBase64: string
): Promise<{ ok: boolean; bytes: number; error?: string }> {
  if (!env.SANDBOX) return { ok: false, bytes: 0, error: "sandbox not configured" };
  try {
    const res = await env.SANDBOX.fetch("https://zay-sandbox/workspace/put", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SBOX_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId, path, contentBase64 }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      bytes?: number;
      error?: string;
    };
    if (!res.ok || data.ok !== true) {
      return { ok: false, bytes: 0, error: data.error || `sandbox HTTP ${res.status}` };
    }
    return { ok: true, bytes: typeof data.bytes === "number" ? data.bytes : 0 };
  } catch (err) {
    return { ok: false, bytes: 0, error: String(err) };
  }
}

/** A small prefix of a workspace text file, for a card title. */export async function readSandboxText(
  env: Env,
  sessionId: string,
  path: string,
  maxBytes = 16_384
): Promise<string | null> {
  if (!env.SANDBOX) return null;
  try {
    const url = new URL("https://zay-sandbox/workspace/read");
    url.searchParams.set("sessionId", sessionId);
    url.searchParams.set("path", path);
    const res = await env.SANDBOX.fetch(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${env.SBOX_TOKEN}` },
    });
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    return new TextDecoder().decode(bytes.slice(0, Math.max(1, maxBytes)));
  } catch {
    return null;
  }
}

/** The live workspace tree, used to find files a turn created. */
export async function listSandboxFiles(
  env: Env,
  sessionId: string
): Promise<{ ok: boolean; files: SandboxListedFile[]; error?: string }> {
  if (!env.SANDBOX) return { ok: false, files: [], error: "sandbox not configured" };
  try {
    const url = new URL("https://zay-sandbox/workspace/files");
    url.searchParams.set("sessionId", sessionId);
    const res = await env.SANDBOX.fetch(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${env.SBOX_TOKEN}` },
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      files?: Array<{ path?: string; bytes?: number; mtime?: number }>;
      error?: string;
    };
    if (!res.ok || data.ok !== true || !Array.isArray(data.files)) {
      return { ok: false, files: [], error: data.error || `sandbox HTTP ${res.status}` };
    }
    return {
      ok: true,
      files: data.files
        .filter((file): file is { path: string; bytes: number; mtime: number } =>
          Boolean(file && typeof file.path === "string")
        )
        .map((file) => ({
          path: file.path,
          bytes: typeof file.bytes === "number" ? file.bytes : 0,
          mtime: typeof file.mtime === "number" ? file.mtime : 0,
        })),
    };
  } catch (err) {
    return { ok: false, files: [], error: String(err) };
  }
}

/** Write a skill package's files into one directory under the sandbox home. */
export async function writeSandboxFiles(
  env: Env,
  sessionId: string,
  dir: string,
  files: SandboxFileWrite[]
): Promise<{ ok: boolean; written: number; bytes: number; dir?: string; error?: string }> {
  if (!env.SANDBOX) {
    return { ok: false, written: 0, bytes: 0, error: "sandbox not configured" };
  }
  try {
    const res = await env.SANDBOX.fetch("https://zay-sandbox/workspace/write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SBOX_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId, dir, files }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      written?: number;
      bytes?: number;
      dir?: string;
      error?: string;
    };
    if (!res.ok || data.ok !== true) {
      return {
        ok: false,
        written: 0,
        bytes: 0,
        error: data.error || `sandbox HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      written: typeof data.written === "number" ? data.written : files.length,
      bytes: typeof data.bytes === "number" ? data.bytes : 0,
      dir: typeof data.dir === "string" ? data.dir : undefined,
    };
  } catch (err) {
    return { ok: false, written: 0, bytes: 0, error: String(err) };
  }
}

/** Copy one session's saved workspace archive into another session. */
export async function copySandboxWorkspace(
  env: Env,
  from: string,
  to: string
): Promise<{
  ok: boolean;
  bytes: number;
  files: number;
  sha256: string;
  reason?: string;
  error?: string;
}> {
  if (!env.SANDBOX) {
    return { ok: false, bytes: 0, files: 0, sha256: "", error: "sandbox not configured" };
  }
  try {
    const res = await env.SANDBOX.fetch("https://zay-sandbox/workspace/copy", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SBOX_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from, to }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      bytes?: number;
      files?: number;
      sha256?: string;
      reason?: string;
      error?: string;
    };
    if (!res.ok || data.ok !== true) {
      return {
        ok: false,
        bytes: 0,
        files: 0,
        sha256: "",
        ...(data.reason ? { reason: data.reason } : {}),
        error: data.error || `sandbox HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      bytes: typeof data.bytes === "number" ? data.bytes : 0,
      files: typeof data.files === "number" ? data.files : 0,
      sha256: typeof data.sha256 === "string" ? data.sha256 : "",
    };
  } catch (err) {
    return { ok: false, bytes: 0, files: 0, sha256: "", error: String(err) };
  }
}
