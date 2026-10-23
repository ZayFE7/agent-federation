// Unit tests for src/frames.ts: the wire vocabulary the console consumes.
// Plain Node: `node tests/frames.test.mjs`. Silent on success (exit 0).

import assert from "node:assert/strict";
import {
  TOOL_WIDGET,
  encodeFrame,
  framesFromChunk,
  framesFromEvent,
} from "../src/frames.ts";

const failures = [];

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

check("TOOL_WIDGET maps every wired tool to a label and mascot state", () => {
  assert.deepEqual(TOOL_WIDGET.exec, { label: "Shell", state: "code" });
  assert.deepEqual(TOOL_WIDGET.web_search, { label: "Search", state: "search" });
  assert.equal(TOOL_WIDGET.schedule_task.state, "calendar");
  assert.equal(TOOL_WIDGET.save_workspace.state, "data");
  assert.equal(TOOL_WIDGET.delegate.state, "delegate");
});

check("text-delta becomes one text frame", () => {
  assert.deepEqual(framesFromChunk({ type: "text-delta", id: "t1", delta: "hi" }), [
    { t: "text", d: "hi" },
  ]);
});

check("textDelta spelling is accepted too", () => {
  assert.deepEqual(framesFromChunk({ type: "text-delta", id: "t1", textDelta: "hi" }), [
    { t: "text", d: "hi" },
  ]);
});

check("reasoning-delta becomes a reasoning frame", () => {
  assert.deepEqual(
    framesFromChunk({ type: "reasoning-delta", id: "r1", delta: "thinking" }),
    [{ t: "reasoning", d: "thinking" }]
  );
});

check("tool-input-start mounts a widget with the tool's state", () => {
  const out = framesFromChunk({
    type: "tool-input-start",
    toolCallId: "c1",
    toolName: "web_search",
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].t, "tool-start");
  assert.equal(out[0].id, "c1");
  assert.equal(out[0].name, "web_search");
  assert.equal(out[0].state, "search");
  assert.equal(out[0].label, "Search");
  assert.equal(out[0].input, "");
});

check("tool-input-available updates the same widget with the full input", () => {
  const out = framesFromChunk({
    type: "tool-input-available",
    toolCallId: "c1",
    toolName: "exec",
    input: { cmd: "ls -la" },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].t, "tool-start");
  assert.equal(out[0].id, "c1");
  assert.equal(out[0].state, "code");
  assert.match(out[0].input, /ls -la/);
});

check("tool-output-available settles the widget as ok", () => {
  const out = framesFromChunk({
    type: "tool-output-available",
    toolCallId: "c1",
    output: "exit 0\nstdout:\nhello",
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].t, "tool-result");
  assert.equal(out[0].id, "c1");
  assert.equal(out[0].ok, true);
  assert.match(out[0].output, /hello/);
});

check("tool-output-error settles the widget as failed", () => {
  const out = framesFromChunk({
    type: "tool-output-error",
    toolCallId: "c1",
    errorText: "boom",
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].t, "tool-result");
  assert.equal(out[0].ok, false);
  assert.match(out[0].output, /boom/);
});

check("an unknown chunk returns an empty array and never throws", () => {
  assert.deepEqual(framesFromChunk({ type: "something-new", value: 1 }), []);
  assert.deepEqual(framesFromChunk(null), []);
});

check("the SDK's redacted error chunk is dropped, not forwarded", () => {
  // `ai`'s default onError emits this constant for every server error. The terminal
  // hub.fail frame carries the reason, so this one only shadows it.
  assert.deepEqual(framesFromChunk({ type: "error", errorText: "An error occurred." }), []);
});

check("a detailed error chunk still reaches the console", () => {
  const out = framesFromChunk({
    type: "error",
    errorText: "HTTP 503: model is experiencing high demand",
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].t, "error");
  assert.match(out[0].message, /503/);
});

check("encodeFrame is one data line and a blank line", () => {
  const wire = encodeFrame({ t: "text", d: "line one\nline two" });
  assert.equal(wire.startsWith("data: "), true);
  assert.equal(wire.endsWith("\n\n"), true);
  const body = wire.slice(6, -2);
  assert.equal(body.includes("\n"), false, "JSON must escape newlines");
  assert.deepEqual(JSON.parse(body), { t: "text", d: "line one\nline two" });
});

check("no frame label contains an em dash", () => {
  for (const [name, meta] of Object.entries(TOOL_WIDGET)) {
    assert.equal(meta.label.includes("\u2014"), false, `${name} label contains an em dash`);
  }
});

check("framesFromEvent maps chunk events and ignores unmapped ones", () => {
  assert.deepEqual(
    framesFromEvent({ type: "chunk", operationId: "op1", chunk: { type: "text-delta", id: "t", delta: "x" } }),
    [{ t: "text", d: "x" }]
  );
  assert.deepEqual(framesFromEvent({ type: "transcript" }), []);
});

check("framesFromEvent turns a parked message part into an approval frame", () => {
  const frames = framesFromEvent({
    type: "message",
    operationId: "op1",
    message: {
      role: "assistant",
      parts: [
        {
          type: "tool-exec",
          toolCallId: "tc9",
          state: "approval-requested",
          approval: { id: "approval:tc9" },
          input: { cmd: "rm -rf /tmp/x" },
        },
      ],
    },
  });
  assert.deepEqual(frames, [
    { t: "approval", id: "approval:tc9", toolCallId: "tc9", label: "Shell", cmd: "rm -rf /tmp/x" },
  ]);
});

check("framesFromEvent ignores messages with no parked part", () => {
  assert.deepEqual(
    framesFromEvent({ type: "message", message: { parts: [{ type: "text", text: "hi" }] } }),
    []
  );
  assert.deepEqual(
    framesFromEvent({
      type: "message",
      message: { parts: [{ type: "tool-exec", toolCallId: "tc1", state: "output-available" }] },
    }),
    []
  );
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`frames: ${failures.length} failed`);
  process.exit(1);
}
