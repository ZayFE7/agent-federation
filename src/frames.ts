// The console's streaming vocabulary. Harness events and AI SDK chunks are
// translated here, not in the UI, so the wire format has one owner and an
// offline test can pin it without a Durable Object or a model.
//
// Type-only imports keep this module loadable by plain Node: `ai` and `agents`
// bind platform types at runtime, and tests/frames.test.mjs is dependency-free.

import type { UIMessageChunk } from "ai";
import type { ThinkSessionEvent } from "agents/harness/think";

export type StreamFrame =
  | { t: "text"; d: string }
  | { t: "reasoning"; d: string }
  | { t: "tool-start"; id: string; name: string; label: string; state: string; input: string }
  | { t: "tool-progress"; id: string; phase: string; message: string; fraction: number | null; tail?: string }
  | { t: "tool-result"; id: string; name: string; ok: boolean; output: string }
  | { t: "approval"; id: string; toolCallId: string; label: string; cmd: string }
  | { t: "state"; state: string; verb: string }
  | { t: "step"; n: number; max: number }
  | { t: "done"; reply: string }
  | { t: "error"; message: string };

/** The existing console widgets: one label and mascot pose per tool. */
export const TOOL_WIDGET: Record<string, { label: string; state: string }> = Object.freeze({
  exec: { label: "Shell", state: "code" },
  web_search: { label: "Search", state: "search" },
  schedule_task: { label: "Schedule", state: "calendar" },
  save_workspace: { label: "Snapshot", state: "data" },
  delegate: { label: "Delegate", state: "delegate" },
});

const FALLBACK_WIDGET = { label: "Tool", state: "code" };

/**
 * `ai`'s default `onError` replaces every server-side error with this constant so
 * internals cannot reach the browser. ThinkHarness does not override it, so a failing
 * model call produces this frame *and* the terminal `hub.fail` frame that carries the
 * real reason. The console tears down on the first error it sees, so forwarding the
 * redacted one would show "An error occurred." and swallow the useful text.
 */
const SDK_REDACTED_ERROR = "An error occurred.";

function widgetFor(name: string): { label: string; state: string } {
  return TOOL_WIDGET[name] ?? FALLBACK_WIDGET;
}

/** Any unknown value as display text. Objects are JSON, never "[object Object]". */
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Map one AI SDK UI chunk onto zero or more frames. Unmapped chunk types are
 * dropped: a new upstream chunk must never break a live stream.
 */
export function framesFromChunk(chunk: UIMessageChunk): StreamFrame[] {
  const c = asRecord(chunk);
  if (!c) return [];
  switch (c.type) {
    case "text-delta": {
      const d = text(c.delta ?? c.textDelta);
      return d ? [{ t: "text", d }] : [];
    }
    case "reasoning-delta": {
      const d = text(c.delta ?? c.textDelta);
      return d ? [{ t: "reasoning", d }] : [];
    }
    case "tool-input-start": {
      const id = text(c.toolCallId);
      const name = text(c.toolName);
      if (!id) return [];
      const w = widgetFor(name);
      return [{ t: "tool-start", id, name, label: w.label, state: w.state, input: "" }];
    }
    case "tool-input-available": {
      const id = text(c.toolCallId);
      const name = text(c.toolName);
      if (!id) return [];
      const w = widgetFor(name);
      return [
        {
          t: "tool-start",
          id,
          name,
          label: w.label,
          state: w.state,
          input: text(c.input),
        },
      ];
    }
    case "tool-input-delta": {
      const id = text(c.toolCallId);
      const tail = text(c.inputTextDelta);
      return id && tail
        ? [{ t: "tool-progress", id, phase: "input", message: "", fraction: null, tail }]
        : [];
    }
    case "tool-output-available": {
      const id = text(c.toolCallId);
      return id
        ? [{ t: "tool-result", id, name: "", ok: true, output: text(c.output) }]
        : [];
    }
    case "tool-output-error": {
      const id = text(c.toolCallId);
      return id
        ? [{ t: "tool-result", id, name: "", ok: false, output: text(c.errorText) }]
        : [];
    }
    case "tool-output-denied": {
      const id = text(c.toolCallId);
      return id
        ? [{ t: "tool-result", id, name: "", ok: false, output: "denied" }]
        : [];
    }
    case "tool-approval-request": {
      const id = text(c.approvalId);
      const toolCallId = text(c.toolCallId);
      if (!id || !toolCallId) return [];
      return [
        {
          t: "approval",
          id,
          toolCallId,
          label: "Approval",
          cmd: text(c.inputSchemaInput ?? c.approvalDescriptor),
        },
      ];
    }
    case "error": {
      const message = text(c.errorText);
      if (!message || message === SDK_REDACTED_ERROR) return [];
      return [{ t: "error", message }];
    }
    default:
      return [];
  }
}

/** Map a harness session event. Chunks carry the live content; the rest is state. */
export function framesFromEvent(ev: ThinkSessionEvent): StreamFrame[] {
  const e = asRecord(ev);
  if (!e) return [];
  if (e.type === "chunk") return framesFromChunk(e.chunk as UIMessageChunk);
  if (e.type === "run-start") return [{ t: "state", state: "think", verb: "Thinking" }];
  return [];
}

/** One SSE `data:` frame. JSON.stringify escapes newlines inside strings. */
export function encodeFrame(f: StreamFrame): string {
  return `data: ${JSON.stringify(f)}\n\n`;
}
