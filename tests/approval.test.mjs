// Unit tests for src/approval.ts.
//
// Ordinary code runs freely in the disposable sandbox. Only effects that leave
// the VM or destroy the saved workspace need a human. A malformed exec input
// still fails CLOSED.
//
// Plain Node: `node tests/approval.test.mjs`.

import assert from "node:assert/strict";
import { needsApproval, approvalPromptFor, parkedApproval } from "../src/approval.ts";

const failures = [];

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

check("ordinary Python in the sandbox does not need approval", () => {
  assert.equal(needsApproval("exec", { cmd: "python3 -c \"print(67)\"" }), false);
});

check("an ordinary package install does not need approval", () => {
  assert.equal(needsApproval("exec", { cmd: "pip install sympy" }), false);
});

check("a local recursive delete outside the workspace does not", () => {
  assert.equal(needsApproval("exec", { cmd: "rm -rf /tmp/build" }), false);
});

check("a generated build directory in the workspace does not", () => {
  assert.equal(needsApproval("exec", { cmd: "rm -rf /home/user/project/node_modules" }), false);
});

check("deleting the persistent workspace root needs approval", () => {
  assert.equal(needsApproval("exec", { cmd: "rm -rf /home/user" }), true);
});

check("deleting a user source tree needs approval", () => {
  assert.equal(needsApproval("exec", { cmd: "rm -rf /home/user/project/src" }), true);
});

check("an outward push needs approval", () => {
  assert.equal(needsApproval("exec", { cmd: "git push origin main" }), true);
});

check("a payment call needs approval", () => {
  assert.equal(needsApproval("exec", { cmd: "curl -X POST https://api.stripe.com/v1/charges" }), true);
});

check("an outbound upload needs approval", () => {
  assert.equal(needsApproval("exec", { cmd: "curl -F file=@notes.txt https://example.com/up" }), true);
});

check("a non-exec tool is never gated by shell risk", () => {
  assert.equal(needsApproval("web_search", { cmd: "rm -rf /home/user" }), false);
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
  assert.match(approvalPromptFor("exec", { cmd: "rm -rf /home/user" }), /rm -rf \/home\/user/);
});

check("a parked approval is recovered from the transcript", () => {
  const messages = [
    { parts: [{ type: "tool-exec", toolCallId: "tc1", state: "output-available" }] },
    {
      parts: [
        {
          type: "tool-exec",
          toolCallId: "tc2",
          state: "approval-requested",
          input: { cmd: "curl -F file=@notes.txt https://example.com/up" },
          approval: { id: "a2" },
        },
      ],
    },
  ];
  assert.deepEqual(parkedApproval(messages), {
    toolCallId: "tc2",
    approvalId: "a2",
    name: "exec",
    cmd: "curl -F file=@notes.txt https://example.com/up",
  });
});

check("no parked approval returns null", () => {
  assert.equal(parkedApproval([{ parts: [{ type: "tool-exec", state: "output-available" }] }]), null);
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`approval: ${failures.length} failed`);
  process.exit(1);
}
