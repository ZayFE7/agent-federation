// Capability copy has one source: src/capabilities.ts (plan Task 29).
//
// Why this file exists. The console's Tools tab used to carry its own hand-written
// list of capabilities, and that list promised a browser that was never built
// (`Browser worker: planned, not wired yet`) while staying silent about tools that
// did work. Two copies of a promise drift, and the drift is invisible to whoever
// edits the code that serves the other copy. So the promise is generated from the
// capability table, served by `GET /api/capabilities`, and rendered by the console;
// every check here is a way of proving that a second copy did not come back.
//
// What "drift" means mechanically, in order of how it was seen before:
//   - an unhedged future-tense promise in shipped UI copy;
//   - a tool name claimed in the agent that is not in EXPECTED_TOOLS, so the model
//     is told about a call it will never be given;
//   - the same sentence maintained in two files, where one of them is the one the
//     model or the user actually reads;
//   - a tool description that no longer matches what the code does, which is the
//     contract a non-deterministic caller trusts.
//
// Plain Node, no framework: `node tests/no-drift.test.mjs`. Silent on success
// (exit 0). Prints every failure and exits 1 otherwise.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_TOOLS,
  SANDBOX_HOME,
  capabilityList,
  capabilitiesText,
} from "../src/capabilities.ts";
// Namespace import so a missing export shows up as a FAIL below rather than as a
// module-link error that hides every other finding in this file.
import * as capabilities from "../src/capabilities.ts";
import { SNAPSHOT_LIMIT_BYTES, formatLimit } from "../src/workspace-keys.ts";
import { buildTools } from "../src/tools.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const html = read("ui/index.html");
const agentSrc = read("src/agent.ts");
const readme = read("README.md");

const failures = [];

async function check(name, fn) {
  try {
    await fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

/** The banned phrase plus the exact source line that carries it, for a readable FAIL. */
function offender(text, needle) {
  const line = text.split(/\r?\n/).find((l) => l.includes(needle));
  return line ? `found "${needle}" in: ${line.trim().slice(0, 160)}` : `found "${needle}"`;
}

const FUTURE_PROMISES = ["planned", "not wired", "Browser worker"];

await check("shipped UI copy promises nothing it cannot do", () => {
  for (const needle of FUTURE_PROMISES) {
    assert.equal(html.includes(needle), false, offender(html, needle));
  }
});

await check("the README promises nothing the table does not", () => {
  for (const needle of FUTURE_PROMISES) {
    assert.equal(readme.includes(needle), false, offender(readme, needle));
  }
});

await check("the console gets its capability rows from the route", () => {
  assert.equal(html.includes("/api/capabilities"), true, "ui/index.html never fetches /api/capabilities");
});

// The route's payload is the only place these sentences are written. If any of
// them reappears in the console source, someone pasted a copy and it will drift.
await check("no capability sentence is maintained twice", () => {
  const details = capabilityList(EXPECTED_TOOLS, SANDBOX_HOME).map((c) => c.detail);
  for (const file of ["ui/index.html", "README.md"]) {
    const text = read(file);
    for (const detail of details) {
      const probe = detail.slice(0, 40);
      assert.equal(text.includes(probe), false, `${file} restates a capability detail: ${probe}`);
    }
  }
});

// The agent logs tool rows by name; a name outside EXPECTED_TOOLS is a capability
// claim about a call the model never receives.
await check("every tool name claimed in the agent is wired", () => {
  const claimed = [...agentSrc.matchAll(/\{\s*name:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(claimed.length > 0, "the regex found no tool claims in src/agent.ts, so this check proves nothing");
  for (const name of claimed) {
    assert.equal(EXPECTED_TOOLS.includes(name), true, `src/agent.ts claims "${name}", which is not in EXPECTED_TOOLS`);
  }
});

// The deterministic "what can you do" answer used to be pasted prose in the agent;
// now the agent composes and the sentence lives in the table module.
await check("the agent restates no capability prose", () => {
  assert.equal(agentSrc.includes("Right now I can:"), false, "src/agent.ts hand-writes the capability answer");
  assert.equal(agentSrc.includes("high-risk commands"), false, "src/agent.ts restates the safety note");
  assert.equal(agentSrc.includes("capabilityAnswer"), true, "src/agent.ts does not build the answer from the table");
  assert.ok((capabilities.SAFETY_NOTE ?? "").length > 40, "capabilities.SAFETY_NOTE is missing or too thin to be the single source");
  const answer = capabilities.capabilityAnswer(EXPECTED_TOOLS);
  assert.ok(answer.includes(capabilities.SAFETY_NOTE), "the generated answer dropped the safety note");
  assert.ok(answer.includes("Linux sandbox"), "the generated answer dropped a wired capability");
  assert.equal(answer.includes("\u2014"), false, "em dash in the generated capability answer");
});

// Task 29 makes snapshotting automatic on turn end and pins the ceiling; the
// description the model reads has to say both or it will call a tool for a reason
// that no longer exists and stay silent about the limit that does.
await check("save_workspace describes the real limit and the automatic path", () => {
  const deps = {
    exec: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" }),
    snapshot: async () => ({ ok: true, output: "" }),
    search: async () => ({ ok: true, output: "" }),
    schedule: async () => ({ ok: true, output: "" }),
    onEvent: () => {},
  };
  const desc = buildTools(deps).save_workspace.description;
  assert.ok(typeof desc === "string" && desc.length > 40, "save_workspace has no usable description");
  assert.equal(
    desc.includes(formatLimit(SNAPSHOT_LIMIT_BYTES)),
    true,
    `save_workspace description does not name the ${formatLimit(SNAPSHOT_LIMIT_BYTES)} limit`
  );
  assert.equal(/automatic/i.test(desc), true, "save_workspace description does not say snapshotting is automatic");
  assert.equal(
    /nothing is snapshotted automatically/i.test(desc),
    false,
    "save_workspace description still says snapshotting never happens by itself"
  );
  assert.equal(desc.includes("\u2014"), false, "save_workspace description contains an em dash");
});

if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL ${f}`);
  process.exit(1);
}
