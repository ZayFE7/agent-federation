// Unit tests for src/tools.ts: the wired set is exactly EXPECTED_TOOLS, every
// description is usable by the model, and only read-only tools opt into rerun.
// Plain Node: `node tests/tools.test.mjs`. Silent on success (exit 0).

import assert from "node:assert/strict";
import { buildTools } from "../src/tools.ts";
import { EXPECTED_TOOLS } from "../src/capabilities.ts";

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

const tools = buildTools(deps);

check("buildTools wires exactly EXPECTED_TOOLS, in order", () => {
  assert.deepEqual(Object.keys(tools), [...EXPECTED_TOOLS]);
});

check("EXPECTED_TOOLS is frozen", () => {
  assert.ok(Object.isFrozen(EXPECTED_TOOLS), "EXPECTED_TOOLS must be frozen");
});

check("exec does not opt into rerun (it writes)", () => {
  assert.equal("recovery" in tools.exec, false);
});

check("web_search opts into rerun (read-only)", () => {
  assert.equal(tools.web_search.recovery, "rerun");
});

check("every tool has a substantive, em-dash-free description", () => {
  for (const [name, t] of Object.entries(tools)) {
    assert.ok(typeof t.description === "string" && t.description.length > 40, `${name} description too short`);
    assert.equal(t.description.includes("\u2014"), false, `${name} description contains an em dash`);
  }
});

check("web_search states the default cap and the truncation path", () => {
  const d = tools.web_search.description;
  assert.match(d, /Defaults to 5/i);
  assert.match(d, /truncat/i);
  assert.match(d, /raise max_results|narrow the query/i);
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`tools: ${failures.length} failed`);
  process.exit(1);
}
