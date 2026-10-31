// Trusted evidence collection for a finished goal step. This module never reads
// a file, artifact store, or SQL table itself: every fact comes from an injected
// callback, so the coordinator can run it without sandbox access and tests can
// run it without a filesystem. Evidence is capped with an explicit truncation
// marker before it can reach a prompt or a 2 MB Durable Object row.
//
// Dependency-free at runtime: the shared Check shape is imported as a type only.

import type { Check } from "./goal-types.ts";

export type EvidenceStatus = "ok" | "missing" | "mismatch" | "error" | "delegated";

export interface EvidenceItem {
  /** Position in the step's checks array, so deterministic checks align even after capping. */
  index: number;
  kind: string;
  label: string;
  status: EvidenceStatus;
  /** Convenience mirror: true for ok and delegated, false for missing/mismatch/error. */
  ok?: boolean;
  detail: string;
  path?: string;
  tool?: string;
  criterion?: string;
  exists?: boolean;
  present?: boolean;
  bytes?: number | null;
  sha256?: string | null;
  expected_sha256?: string | null;
  min_bytes?: number | null;
  code?: number | null;
  expected_code?: number | null;
  calls?: number;
}

export interface Evidence {
  run_id: string | null;
  items: EvidenceItem[];
  missing: string[];
  mismatches: string[];
  errors: string[];
  truncated: boolean;
  omitted: number;
  bytes: number;
  cap_bytes: number;
  note?: string;
}

export interface FileInfo {
  exists?: boolean;
  bytes?: number | null;
  /** Alias accepted from sandbox manifests that call the size `size`. */
  size?: number | null;
  sha256?: string | null;
  /** Alias accepted from manifests that call the digest `hash`. */
  hash?: string | null;
  content?: string | Uint8Array | null;
  error?: string | null;
}

export interface ArtifactInfo {
  path?: string;
  title?: string;
  bytes?: number | null;
  size?: number | null;
  present?: boolean;
  exists?: boolean;
}

export interface ToolCallRecord {
  tool?: string;
  status?: string;
  exit_code?: number | null;
  exitCode?: number | null;
  code?: number | null;
  result?: unknown;
  result_json?: string | null;
  side_effect?: number | boolean;
  [key: string]: unknown;
}

export interface ToolExitInfo {
  code?: number | null;
  exit?: number | null;
  exit_code?: number | null;
  exitCode?: number | null;
}

/**
 * Every capability collectEvidence is allowed to use. `toolCalls` and `toolExit`
 * are alternatives: a caller with the write-ahead ledger uses toolCalls, and a
 * caller with a summarized exit uses toolExit. `sha256` is injected so this
 * module stays free of crypto/platform assumptions.
 */
export interface EvidenceSources {
  runId?: string | null;
  fileInfo(
    path: string
  ): Promise<FileInfo | null | undefined> | FileInfo | null | undefined;
  artifact(
    path: string
  ):
    | Promise<ArtifactInfo | boolean | null | undefined>
    | ArtifactInfo
    | boolean
    | null
    | undefined;
  toolCalls?(
    runId: string
  ): Promise<ToolCallRecord[] | null | undefined> | ToolCallRecord[] | null | undefined;
  toolExit?(
    tool: string
  ): Promise<number | ToolExitInfo | null | undefined> | number | ToolExitInfo | null | undefined;
  sha256?(value: string | Uint8Array): Promise<string> | string;
  /** Alias for the injected hasher. */
  hash?(value: string | Uint8Array): Promise<string> | string;
  /** Test hook only; production callers leave this at the 32 KB spec cap. */
  max_bytes?: number;
  maxBytes?: number;
}

const MAX_EVIDENCE_BYTES = 32 * 1024;
const MAX_ITEM_DETAIL = 600;
const MAX_LABEL = 300;
const MAX_SUMMARY_ENTRIES = 40;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const keep = Math.max(1, max - 24);
  return `${value.slice(0, keep)}... [truncated]`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function contentBytes(content: string | Uint8Array | null | undefined): number | null {
  if (typeof content === "string") return new TextEncoder().encode(content).length;
  if (content instanceof Uint8Array) return content.byteLength;
  return null;
}

function readCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed)) return parsed;
  }
  const row = asRecord(value);
  for (const key of ["exit_code", "exitCode", "exit", "code"]) {
    const candidate = row[key];
    if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
  }
  return null;
}

function toolCallCode(call: ToolCallRecord): number | null {
  const direct = readCode(call);
  if (direct !== null) return direct;
  let result = call.result;
  if (result === undefined && typeof call.result_json === "string") {
    try {
      result = JSON.parse(call.result_json);
    } catch {
      result = call.result_json;
    }
  }
  const fromResult = readCode(result);
  if (fromResult !== null) return fromResult;
  if (typeof result === "string") {
    const match = /exit(?:\s+code)?\s*[:=]?\s*(-?\d+)/i.exec(result);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isInteger(parsed)) return parsed;
    }
  }
  return null;
}

function toolName(call: ToolCallRecord): string {
  return asText(call.tool).toLowerCase();
}

function artifactPresent(value: ArtifactInfo | boolean | null | undefined): boolean {
  if (value === true) return true;
  if (!value || typeof value !== "object") return false;
  if (value.exists === false || value.present === false) return false;
  return true;
}

function evidenceNote(cap: number): string {
  return `evidence truncated to ${cap} bytes; later items or summaries were omitted`;
}

function finalizeEvidence(base: Evidence, cap: number): Evidence {
  const fullNote = evidenceNote(cap);
  const output: Evidence = {
    ...base,
    truncated: base.truncated || base.omitted > 0,
    // A nine-digit placeholder means the measured size is an upper bound for the
    // final (smaller) byte count, so filling it in cannot push the object over cap.
    bytes: 999_999_999,
    note: base.truncated || base.omitted > 0 ? fullNote : base.note,
  };
  const size = () => byteLength(JSON.stringify(output));

  while (size() > cap) {
    output.truncated = true;
    output.note = fullNote;
    if (output.items.length > 0) {
      output.items.pop();
      output.omitted += 1;
    } else if (output.errors.length > 0) {
      output.errors.pop();
    } else if (output.mismatches.length > 0) {
      output.mismatches.pop();
    } else if (output.missing.length > 0) {
      output.missing.pop();
    } else {
      // Everything droppable is gone. Drop the note, then shorten the run id.
      output.note = "evidence truncated";
      if (output.run_id && output.run_id.length > 40) {
        output.run_id = clip(output.run_id, 40);
        continue;
      }
      if (output.run_id !== null) {
        output.run_id = null;
        continue;
      }
      break;
    }
  }
  // Settle the real byte count; the nine-digit placeholder guaranteed headroom.
  output.bytes = 0;
  for (let i = 0; i < 5; i += 1) {
    const measured = byteLength(JSON.stringify(output));
    if (output.bytes === measured) break;
    output.bytes = measured;
  }
  return output;
}

/**
 * Collect evidence for each structured check using only the supplied callbacks.
 * Text checks are marked delegated: they are judgment criteria for the model
 * verifier, not something trusted code can prove. The returned object never
 * contains model prose, only paths, sizes, hashes, exit codes, and criteria.
 */
export async function collectEvidence(
  checks: Check[],
  sources: EvidenceSources
): Promise<Evidence> {
  const list = Array.isArray(checks) ? checks : [];
  const runId = asText(sources?.runId) || null;
  const configuredCap = (sources?.max_bytes ?? sources?.maxBytes) as number | undefined;
  const cap = Math.max(
    256,
    Math.min(
      MAX_EVIDENCE_BYTES,
      typeof configuredCap === "number" && Number.isFinite(configuredCap)
        ? Math.floor(configuredCap)
        : MAX_EVIDENCE_BYTES
    )
  );
  const items: EvidenceItem[] = [];
  const missing: string[] = [];
  const mismatches: string[] = [];
  const errors: string[] = [];

  const fileCache = new Map<string, FileInfo | null>();
  const artifactCache = new Map<string, ArtifactInfo | boolean | null>();
  let callsCache: ToolCallRecord[] | null = null;
  let callsError: string | null = null;

  const pushSummary = (target: string[], value: string) => {
    const clipped = clip(value, MAX_LABEL);
    if (target.length < MAX_SUMMARY_ENTRIES) target.push(clipped);
  };

  const loadCalls = async (): Promise<ToolCallRecord[]> => {
    if (callsCache !== null) return callsCache;
    if (typeof sources?.toolCalls !== "function") {
      callsCache = [];
      return callsCache;
    }
    try {
      const rows = await sources.toolCalls(runId ?? "");
      callsCache = Array.isArray(rows) ? rows : [];
    } catch (err) {
      callsError = err instanceof Error ? err.message : String(err);
      callsCache = [];
    }
    return callsCache;
  };

  for (let index = 0; index < list.length; index += 1) {
    const check = asRecord(list[index]);
    const type = asText(check.type).toLowerCase();
    const labelPrefix = type || "unknown";

    if (type === "text") {
      const criterion = clip(asText(check.criterion), 500);
      items.push({
        index,
        kind: "text",
        label: `text:${clip(criterion, 200)}`,
        criterion,
        status: "delegated",
        detail: "Judgment criterion. It is for the verifier to read, not deterministic code.",
      });
      continue;
    }

    if (type === "file") {
      const path = asText(check.path);
      const label = `file:${path || "(no path)"}`;
      if (!path) {
        const detail = "file check has no path";
        items.push({ index, kind: "file", label, status: "error", detail });
        pushSummary(errors, `${label}: ${detail}`);
        continue;
      }
      let info: FileInfo | null;
      try {
        info = (fileCache.has(path)
          ? fileCache.get(path) ?? null
          : await sources.fileInfo(path)) ?? null;
        fileCache.set(path, info);
      } catch (err) {
        const detail = `fileInfo failed: ${err instanceof Error ? err.message : String(err)}`;
        items.push({ index, kind: "file", label, path, status: "error", detail });
        pushSummary(errors, `${label}: ${detail}`);
        continue;
      }
      if (!info || info.exists === false) {
        const detail = "file does not exist";
        items.push({
          index,
          kind: "file",
          label,
          path,
          exists: false,
          status: "missing",
          detail,
        });
        pushSummary(missing, `${label}: ${detail}`);
        continue;
      }
      if (typeof info.error === "string" && info.error) {
        const detail = clip(info.error, MAX_ITEM_DETAIL);
        items.push({ index, kind: "file", label, path, status: "error", detail });
        pushSummary(errors, `${label}: ${detail}`);
        continue;
      }

      const declaredBytes = info.bytes ?? info.size;
      const bytes =
        typeof declaredBytes === "number" && Number.isFinite(declaredBytes)
          ? declaredBytes
          : contentBytes(info.content);
      let hash =
        asText(info.sha256).toLowerCase() || asText(info.hash).toLowerCase() || null;
      if (!hash && info.content !== undefined && info.content !== null) {
        const hasher = sources.sha256 ?? sources.hash;
        if (typeof hasher === "function") {
          try {
            hash = asText(await hasher(info.content)).toLowerCase() || null;
          } catch (err) {
            const detail = `hashing failed: ${err instanceof Error ? err.message : String(err)}`;
            items.push({
              index,
              kind: "file",
              label,
              path,
              exists: true,
              bytes,
              status: "error",
              detail,
            });
            pushSummary(errors, `${label}: ${detail}`);
            continue;
          }
        }
      }

      const expectedMin =
        typeof check.min_bytes === "number" && Number.isFinite(check.min_bytes)
          ? Math.floor(check.min_bytes)
          : null;
      const expectedMax =
        typeof check.max_bytes === "number" && Number.isFinite(check.max_bytes)
          ? Math.floor(check.max_bytes)
          : null;
      const expectedHash = asText(check.sha256).toLowerCase() || null;
      let status: EvidenceStatus = "ok";
      let detail = `${bytes === null ? "unknown" : bytes} bytes`;
      if (hash) detail += `, sha256 ${hash}`;

      if (expectedMin !== null && bytes === null) {
        status = "error";
        detail = `size unavailable; required at least ${expectedMin} bytes`;
      } else if (expectedMin !== null && bytes !== null && bytes < expectedMin) {
        status = "mismatch";
        detail = `${bytes} bytes is smaller than the required ${expectedMin} bytes`;
      } else if (expectedMax !== null && bytes === null) {
        status = "error";
        detail = `size unavailable; required at most ${expectedMax} bytes`;
      } else if (expectedMax !== null && bytes !== null && bytes > expectedMax) {
        status = "mismatch";
        detail = `${bytes} bytes is larger than the allowed ${expectedMax} bytes`;
      } else if (expectedHash) {
        if (!hash) {
          status = "error";
          detail = `sha256 unavailable; required ${expectedHash}`;
        } else if (hash !== expectedHash) {
          status = "mismatch";
          detail = `sha256 ${hash} does not match ${expectedHash}`;
        }
      }

      items.push({
        index,
        kind: "file",
        label,
        path,
        exists: true,
        bytes,
        sha256: hash,
        status,
        detail: clip(detail, MAX_ITEM_DETAIL),
        ...(expectedMin === null ? {} : { min_bytes: expectedMin }),
        ...(expectedHash === null ? {} : { expected_sha256: expectedHash }),
      });
      if (status === "mismatch") pushSummary(mismatches, `${label}: ${detail}`);
      if (status === "error") pushSummary(errors, `${label}: ${detail}`);
      continue;
    }

    if (type === "artifact") {
      const path = asText(check.path);
      const label = `artifact:${path || "(no path)"}`;
      if (!path) {
        const detail = "artifact check has no path";
        items.push({ index, kind: "artifact", label, status: "error", detail });
        pushSummary(errors, `${label}: ${detail}`);
        continue;
      }
      let info: ArtifactInfo | boolean | null;
      try {
        info = (artifactCache.has(path)
          ? artifactCache.get(path) ?? null
          : await sources.artifact(path)) ?? null;
        artifactCache.set(path, info);
      } catch (err) {
        const detail = `artifact lookup failed: ${
          err instanceof Error ? err.message : String(err)
        }`;
        items.push({ index, kind: "artifact", label, path, status: "error", detail });
        pushSummary(errors, `${label}: ${detail}`);
        continue;
      }
      const present = artifactPresent(info);
      const declaredBytes =
        info && typeof info === "object" ? info.bytes ?? info.size : null;
      const bytes = typeof declaredBytes === "number" ? declaredBytes : null;
      const detail = present ? "artifact is attached" : "artifact is not attached";
      items.push({
        index,
        kind: "artifact",
        label,
        path,
        present,
        exists: present,
        bytes,
        status: present ? "ok" : "missing",
        detail,
      });
      if (!present) pushSummary(missing, `${label}: ${detail}`);
      continue;
    }

    if (type === "tool_exit") {
      const tool = asText(check.tool);
      const label = `tool_exit:${tool || "(no tool)"}`;
      if (!tool) {
        const detail = "tool_exit check has no tool";
        items.push({ index, kind: "tool_exit", label, status: "error", detail });
        pushSummary(errors, `${label}: ${detail}`);
        continue;
      }
      let expected = 0;
      if (check.code !== undefined) {
        if (typeof check.code !== "number" || !Number.isInteger(check.code)) {
          const detail = "tool_exit check has a non-integer exit code";
          items.push({ index, kind: "tool_exit", label, tool, status: "error", detail });
          pushSummary(errors, `${label}: ${detail}`);
          continue;
        }
        expected = check.code;
      }
      const calls = await loadCalls();
      const matching = calls.filter((call) => toolName(call) === tool.toLowerCase());
      let code: number | null = null;
      if (typeof sources.toolExit === "function") {
        try {
          code = readCode(await sources.toolExit(tool));
        } catch (err) {
          const detail = `toolExit failed: ${err instanceof Error ? err.message : String(err)}`;
          items.push({
            index,
            kind: "tool_exit",
            label,
            tool,
            expected_code: expected,
            calls: matching.length,
            status: "error",
            detail,
          });
          pushSummary(errors, `${label}: ${detail}`);
          continue;
        }
      }
      if (code === null) {
        for (let i = matching.length - 1; i >= 0; i -= 1) {
          const fromCall = toolCallCode(matching[i]);
          if (fromCall !== null) {
            code = fromCall;
            break;
          }
        }
      }
      const callCount = matching.length;
      if (code === null) {
        const detail =
          callsError !== null
            ? `tool ledger failed: ${clip(callsError, 300)}`
            : callCount === 0
              ? "no call to this tool is recorded"
              : "the tool call has no recorded exit code";
        const status: EvidenceStatus =
          callsError !== null || callCount > 0 ? "error" : "missing";
        items.push({
          index,
          kind: "tool_exit",
          label,
          tool,
          expected_code: expected,
          calls: callCount,
          status,
          detail,
        });
        pushSummary(status === "missing" ? missing : errors, `${label}: ${detail}`);
        continue;
      }
      const status: EvidenceStatus = code === expected ? "ok" : "mismatch";
      const detail =
        code === expected
          ? `exit ${code} matches the required ${expected}`
          : `exit ${code} does not match the required ${expected}`;
      items.push({
        index,
        kind: "tool_exit",
        label,
        tool,
        expected_code: expected,
        code,
        calls: callCount,
        status,
        detail,
      });
      if (status === "mismatch") pushSummary(mismatches, `${label}: ${detail}`);
      continue;
    }

    if (type === "forbidden_tool") {
      const tool = asText(check.tool);
      const label = `forbidden_tool:${tool || "(no tool)"}`;
      if (!tool) {
        const detail = "forbidden_tool check has no tool";
        items.push({ index, kind: "forbidden_tool", label, status: "error", detail });
        pushSummary(errors, `${label}: ${detail}`);
        continue;
      }
      if (typeof sources.toolCalls !== "function") {
        const detail = "no tool ledger was supplied, so absence cannot be proven";
        items.push({ index, kind: "forbidden_tool", label, tool, status: "error", detail });
        pushSummary(errors, `${label}: ${detail}`);
        continue;
      }
      const calls = await loadCalls();
      if (callsError !== null) {
        const detail = `tool ledger failed: ${clip(callsError, 300)}`;
        items.push({ index, kind: "forbidden_tool", label, tool, status: "error", detail });
        pushSummary(errors, `${label}: ${detail}`);
        continue;
      }
      const found = calls.filter((call) => toolName(call) === tool.toLowerCase());
      const status: EvidenceStatus = found.length === 0 ? "ok" : "mismatch";
      const detail =
        found.length === 0
          ? "the forbidden tool was not called"
          : `the forbidden tool was called ${found.length} time(s)`;
      items.push({
        index,
        kind: "forbidden_tool",
        label,
        tool,
        calls: found.length,
        status,
        detail,
      });
      if (status === "mismatch") pushSummary(mismatches, `${label}: ${detail}`);
      continue;
    }

    if (type === "forbidden_effect") {
      const tool = asText(check.tool);
      const path = asText(check.path);
      const description = asText(check.description);
      const label = `forbidden_effect:${
        tool || path || description || "(unnamed effect)"
      }`;
      if (typeof sources.toolCalls !== "function") {
        const detail = "no tool ledger was supplied, so absence cannot be proven";
        items.push({
          index,
          kind: "forbidden_effect",
          label,
          tool: tool || undefined,
          path: path || undefined,
          status: "error",
          detail,
        });
        pushSummary(errors, `${label}: ${detail}`);
        continue;
      }
      const calls = await loadCalls();
      if (callsError !== null) {
        const detail = `tool ledger failed: ${clip(callsError, 300)}`;
        items.push({
          index,
          kind: "forbidden_effect",
          label,
          ...(tool ? { tool } : {}),
          ...(path ? { path } : {}),
          status: "error",
          detail,
        });
        pushSummary(errors, `${label}: ${detail}`);
        continue;
      }
      const found = calls.filter((call) => {
        if (tool) return toolName(call) === tool.toLowerCase();
        const callPath =
          asText(call.path) ||
          asText(asRecord(call.input).path) ||
          asText(asRecord(call.result).path);
        if (path) return callPath === path;
        return call.side_effect === 1 || call.side_effect === true;
      });
      const status: EvidenceStatus = found.length === 0 ? "ok" : "mismatch";
      const detail =
        found.length === 0
          ? "the forbidden effect did not occur"
          : `the forbidden effect occurred ${found.length} time(s)`;
      items.push({
        index,
        kind: "forbidden_effect",
        label,
        ...(tool ? { tool } : {}),
        ...(path ? { path } : {}),
        calls: found.length,
        status,
        detail,
      });
      if (status === "mismatch") pushSummary(mismatches, `${label}: ${detail}`);
      continue;
    }

    const detail = `unsupported check type ${JSON.stringify(type || "(missing)")}`;
    items.push({
      index,
      kind: labelPrefix,
      label: `${labelPrefix}:unsupported`,
      status: "error",
      detail,
    });
    pushSummary(errors, detail);
  }

  const base: Evidence = {
    run_id: runId,
    items: items.map((item) => ({
      ...item,
      ok: item.status === "ok" || item.status === "delegated",
    })),
    missing,
    mismatches,
    errors,
    truncated: false,
    omitted: 0,
    bytes: 0,
    cap_bytes: cap,
  };
  return finalizeEvidence(base, cap);
}
