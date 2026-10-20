// Unit tests for src/approval.ts: only shell commands can be risky, and a
// malformed exec input fails CLOSED. Plain Node: `node tests/approval.test.mjs`.
// Silent on success (exit 0).

import assert from "node:assert/strict";
import { needsApproval, approvalPromptFor } from "../src/approval.ts";

const failures = [];

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

check("a destructive exec ask needs approval", () => {
  assert.equal(needsApproval("exec", { cmd: "rm -rf /tmp/x" }), true);
});

check("a read-only exec ask does not", () => {
  assert.equal(needsApproval("exec", { cmd: "ls -la" }), false);
});

check("only exec is gated by shell risk", () => {
  assert.equal(needsApproval("web_search", { cmd: "rm -rf /" }), false);
});

check("a missing cmd fails closed", () => {
  assert.equal(needsApproval("exec", {}), true);
});

check("a non-string cmd fails closed", () => {
  assert.equal(needsApproval("exec", { cmd: 42 }), true);
});

check("a null input fails closed", () => {
  assert.equal(needsApproval("exec", null), true);
});

check("the prompt names the command", () => {
  assert.match(approvalPromptFor("exec", { cmd: "rm -rf /tmp/x" }), /rm -rf \/tmp\/x/);
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`approval: ${failures.length} failed`);
  process.exit(1);
}
