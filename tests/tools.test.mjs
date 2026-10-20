// Unit tests for src/tools.ts: the wired set is exactly EXPECTED_TOOLS, every
// description is usable by the model, only read-only tools opt into rerun, and
// every tool reports live progress bound to its own toolCallId.
// Plain Node: `node tests/tools.test.mjs`. Silent on success (exit 0).

import assert from "node:assert/strict";
import { buildTools } from "../src/tools.ts";
import { EXPECTED_TOOLS } from "../src/capabilities.ts";

const failures = [];

async function check(name, fn) {
  try {
    await fn();
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

function recordingDeps() {
  const calls = [];
  return {
    calls,
    deps: {
      exec: async (cmd, onProgress) => {
        onProgress?.({ phase: "running", message: cmd, fraction: null, tail: "partial" });
        return { ok: true, exitCode: 0, stdout: "hello\nworld", stderr: "" };
      },
      search: async () => [
        { url: "https://example.com", title: "Example", excerpts: ["excerpt"] },
      ],
      schedule: async () => "scheduled for later",
      snapshot: async () => ({ ok: true, output: "saved" }),
      progress: (toolCallId, p) => calls.push({ toolCallId, ...p }),
    },
  };
}

const tools = buildTools(deps);

await check("buildTools wires exactly EXPECTED_TOOLS, in order", () => {
  assert.deepEqual(Object.keys(tools), [...EXPECTED_TOOLS]);
});

await check("EXPECTED_TOOLS is frozen", () => {
  assert.ok(Object.isFrozen(EXPECTED_TOOLS), "EXPECTED_TOOLS must be frozen");
});

await check("exec does not opt into rerun (it writes)", () => {
  assert.equal("recovery" in tools.exec, false);
});

await check("web_search opts into rerun (read-only)", () => {
  assert.equal(tools.web_search.recovery, "rerun");
});

await check("every tool has a substantive, em-dash-free description", () => {
  for (const [name, t] of Object.entries(tools)) {
    assert.ok(typeof t.description === "string" && t.description.length > 40, `${name} description too short`);
    assert.equal(t.description.includes("\u2014"), false, `${name} description contains an em dash`);
  }
});

await check("web_search states the default cap and the truncation path", () => {
  const d = tools.web_search.description;
  assert.match(d, /Defaults to 5/i);
  assert.match(d, /truncat/i);
  assert.match(d, /raise max_results|narrow the query/i);
});

await check("exec reports an indeterminate start, the interim line, and a final tail", async () => {
  const fake = recordingDeps();
  await buildTools(fake.deps).exec.execute({ cmd: "ls -la" }, { toolCallId: "c-exec" });
  assert.deepEqual(fake.calls[0], {
    toolCallId: "c-exec",
    phase: "running",
    message: "ls -la",
    fraction: null,
  });
  assert.equal(fake.calls[1].tail, "partial");
  const last = fake.calls.at(-1);
  assert.equal(last.toolCallId, "c-exec");
  assert.equal(last.phase, "running");
  assert.equal(last.fraction, 1);
  assert.match(last.tail, /world/);
});

await check("web_search reports the query while searching and settles at 1", async () => {
  const fake = recordingDeps();
  await buildTools(fake.deps).web_search.execute(
    { query: "current docs" },
    { toolCallId: "c-search" }
  );
  assert.equal(fake.calls[0].phase, "searching");
  assert.equal(fake.calls[0].message, "current docs");
  assert.equal(fake.calls[0].fraction, null);
  assert.equal(fake.calls.at(-1).fraction, 1);
});

await check("schedule_task reports the job title while scheduling and settles at 1", async () => {
  const fake = recordingDeps();
  await buildTools(fake.deps).schedule_task.execute(
    { title: "morning check", instructions: "fetch the news" },
    { toolCallId: "c-sched" }
  );
  assert.equal(fake.calls[0].phase, "scheduling");
  assert.equal(fake.calls[0].message, "morning check");
  assert.equal(fake.calls[0].fraction, null);
  assert.equal(fake.calls.at(-1).fraction, 1);
});

await check("save_workspace reports snapshotting and settles at 1", async () => {
  const fake = recordingDeps();
  await buildTools(fake.deps).save_workspace.execute({}, { toolCallId: "c-snap" });
  assert.equal(fake.calls[0].phase, "snapshotting");
  assert.equal(fake.calls[0].fraction, null);
  assert.equal(fake.calls.at(-1).fraction, 1);
});

await check("every tool's final progress is fraction 1, and phases use the fixed vocabulary", async () => {
  const allowed = new Set(["searching", "running", "snapshotting", "scheduling", "restoring", "delegating"]);
  const runs = [
    ["exec", { cmd: "pwd" }],
    ["web_search", { query: "docs" }],
    ["schedule_task", { title: "j", instructions: "i" }],
    ["save_workspace", {}],
  ];
  for (const [name, input] of runs) {
    const fake = recordingDeps();
    await buildTools(fake.deps)[name].execute(input, { toolCallId: `c-${name}` });
    assert.equal(fake.calls.at(-1).fraction, 1, `${name} never reached fraction 1`);
    for (const call of fake.calls) {
      assert.ok(allowed.has(call.phase), `${name} used unknown phase ${call.phase}`);
    }
  }
});

await check("no progress transport is a valid dependency set", async () => {
  const out = await buildTools(deps).exec.execute({ cmd: "pwd" }, { toolCallId: "c" });
  assert.match(out, /exit 0/);
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`tools: ${failures.length} failed`);
  process.exit(1);
}
