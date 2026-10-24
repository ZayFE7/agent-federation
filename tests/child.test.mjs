// The sub-agent recursion guard as a test, not a comment (plan Task 31 Step 2).
// src/child.ts is not importable offline, so this pins what that file is built
// from: the child tool list in src/capabilities.ts and the set src/tools.ts
// actually produces when handed it. The second half covers
// childEventToParentFrames in src/frames.ts, which is the only progress a
// delegate card ever gets.
// Plain Node: `node tests/child.test.mjs`. Silent on success (exit 0).

import assert from "node:assert/strict";
import { CHILD_PERSONA, CHILD_TOOL_NAMES, EXPECTED_TOOLS } from "../src/capabilities.ts";
import { childEventToParentFrames } from "../src/frames.ts";
import { buildTools } from "../src/tools.ts";

const failures = [];

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

const deps = {
  exec: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" }),
  search: async () => [],
  schedule: async () => "scheduled",
  snapshot: async () => ({ ok: true, output: "saved" }),
};

const CHILD_CALL = { id: "parent-call-1", name: "researcher-abc" };

function chunkEvent(chunk) {
  return { type: "chunk", operationId: "child-op", chunk };
}

check("CHILD_TOOL_NAMES is exactly the two read-mostly tools, and frozen", () => {
  assert.deepEqual([...CHILD_TOOL_NAMES], ["exec", "lookup_online"]);
  assert.ok(Object.isFrozen(CHILD_TOOL_NAMES), "CHILD_TOOL_NAMES must be frozen");
});

check("delegate is not in CHILD_TOOL_NAMES", () => {
  assert.equal(CHILD_TOOL_NAMES.includes("delegate"), false);
  assert.equal(CHILD_TOOL_NAMES.includes("schedule_task"), false);
  assert.equal(CHILD_TOOL_NAMES.includes("save_workspace"), false);
});

check("CHILD_TOOL_NAMES is a subset of the parent's set", () => {
  for (const name of CHILD_TOOL_NAMES) {
    assert.ok(EXPECTED_TOOLS.includes(name), `child has ${name}, which the parent does not`);
  }
});

check("buildTools produces exactly CHILD_TOOL_NAMES, no delegate", () => {
  assert.deepEqual(Object.keys(buildTools(deps, CHILD_TOOL_NAMES)), [...CHILD_TOOL_NAMES]);
});

check("a child asking for delegate by name still gets no delegate tool", () => {
  // buildTools drops names it has no builder for, so even a caller that ignored
  // CHILD_TOOL_NAMES cannot hand a child the tool that would let it recurse.
  const greedy = buildTools(deps, [...CHILD_TOOL_NAMES, "delegate"]);
  assert.equal("delegate" in greedy, false);
  assert.deepEqual(Object.keys(greedy), [...CHILD_TOOL_NAMES]);
});

check("the child's tools carry usable, em-dash-free descriptions", () => {
  for (const [name, t] of Object.entries(buildTools(deps, CHILD_TOOL_NAMES))) {
    assert.ok(t.description.length > 40, `${name} description too short`);
    assert.equal(t.description.includes("\u2014"), false, `${name} description has an em dash`);
  }
});

check("CHILD_PERSONA names its reader and its limits, without an em dash", () => {
  assert.match(CHILD_PERSONA, /sub-agent/);
  assert.match(CHILD_PERSONA, /main agent/);
  assert.match(CHILD_PERSONA, /spawn further agents/);
  assert.equal(CHILD_PERSONA.includes("\u2014"), false);
});

check("a child tool start lands on the parent's card as delegating progress", () => {
  const frames = childEventToParentFrames(
    chunkEvent({
      type: "tool-input-available",
      toolCallId: "child-call",
      toolName: "exec",
      input: { cmd: "ls -la" },
    }),
    CHILD_CALL
  );
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], {
    t: "tool-progress",
    id: "parent-call-1",
    phase: "delegating",
    message: "sub-agent researcher-abc ran Shell",
    fraction: null,
    tail: '{"cmd":"ls -la"}',
  });
});

check("a child result and a child failure use the same card, differently", () => {
  const ok = childEventToParentFrames(
    chunkEvent({ type: "tool-output-available", toolCallId: "child-call", output: "exit 0" }),
    CHILD_CALL
  );
  const bad = childEventToParentFrames(
    chunkEvent({ type: "tool-output-error", toolCallId: "child-call", errorText: "boom" }),
    CHILD_CALL
  );
  assert.equal(ok[0].message, "sub-agent researcher-abc got a result");
  assert.equal(ok[0].tail, "exit 0");
  assert.equal(bad[0].message, "sub-agent researcher-abc failed");
  assert.equal(bad[0].tail, "boom");
  assert.equal(bad[0].id, "parent-call-1");
});

check("a child's own tokens, state and approvals never reach the parent", () => {
  // The child's text is not the user's reply, and a parked child call would wait
  // forever because nothing in the console addresses a child's operation.
  assert.deepEqual(
    childEventToParentFrames(chunkEvent({ type: "text-delta", id: "t", delta: "draft" }), CHILD_CALL),
    []
  );
  assert.deepEqual(
    childEventToParentFrames(
      chunkEvent({ type: "reasoning-delta", id: "r", delta: "thinking" }),
      CHILD_CALL
    ),
    []
  );
  assert.deepEqual(childEventToParentFrames({ type: "run-start" }, CHILD_CALL), []);
  assert.deepEqual(
    childEventToParentFrames(
      chunkEvent({ type: "tool-approval-request", approvalId: "a1", toolCallId: "c1" }),
      CHILD_CALL
    ),
    []
  );
});

check("an error event is folded into the card rather than dropped", () => {
  const frames = childEventToParentFrames(
    chunkEvent({ type: "error", errorText: "HTTP 503: high demand" }),
    CHILD_CALL
  );
  assert.equal(frames.length, 1);
  assert.match(frames[0].message, /stopped: HTTP 503/);
});

check("no call id means no frames, so a child can never write an orphan card", () => {
  assert.deepEqual(
    childEventToParentFrames(
      chunkEvent({ type: "tool-input-start", toolCallId: "c", toolName: "exec" }),
      { id: "", name: "researcher-abc" }
    ),
    []
  );
});

check("folded lines are clipped with an explicit truncation notice", () => {
  const long = "x".repeat(600);
  const frames = childEventToParentFrames(
    chunkEvent({
      type: "tool-input-available",
      toolCallId: "c",
      toolName: "exec",
      input: { cmd: long },
    }),
    CHILD_CALL
  );
  assert.match(frames[0].tail, /\[truncated \d+ chars\]$/);
  assert.ok(frames[0].tail.length < 300, `tail escaped the ceiling: ${frames[0].tail.length}`);
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`child: ${failures.length} failed`);
  process.exit(1);
}
