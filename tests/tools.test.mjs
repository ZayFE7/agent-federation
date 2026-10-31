// Unit tests for src/tools.ts: the wired set is exactly EXPECTED_TOOLS, every
// description is usable by the model, only read-only tools opt into rerun, and
// every tool reports live progress bound to its own toolCallId.
// Plain Node: `node tests/tools.test.mjs`. Silent on success (exit 0).

import assert from "node:assert/strict";
import {
  CHILD_REPORT_BYTES,
  buildTools,
  childBusyRefusal,
  childNameFor,
} from "../src/tools.ts";
import {
  CHILD_TOOL_NAMES,
  EXPECTED_TOOLS,
  capabilityList,
  capabilitiesText,
} from "../src/capabilities.ts";
import { TOOL_WIDGET } from "../src/frames.ts";

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
      writeFile: async () => "Wrote a file.",
      progress: (toolCallId, p) => calls.push({ toolCallId, ...p }),
    },
  };
}

// `delegate` is only built for a caller that can actually spawn, and the
// automation tools are only built when the DO supplies their deps. The wired-set
// check hands buildTools both sets.
const tools = buildTools({
  ...deps,
  delegate: async () => "sub-agent report",
  automationCreate: async () => "automation created",
  automationStatus: async () => "automation status",
  automationControl: async () => "automation controlled",
  gmail: async () => "gmail result",
  goalCreate: async () => "goal created",
  goalStatus: async () => "goal status",
  goalControl: async () => "goal controlled",
  generateImage: async () => "image generated",
  generateSpeech: async () => "speech generated",
  transcribeMedia: async () => "transcript ready",
  calendar: async () => "calendar result",
  tasks: async () => "tasks result",
  youtubeTranscript: async () => "youtube transcript",
  remember: async () => "remembered",
});

await check("buildTools wires exactly EXPECTED_TOOLS, in order", () => {
  assert.deepEqual(Object.keys(tools), [...EXPECTED_TOOLS]);
});

await check("EXPECTED_TOOLS is frozen", () => {
  assert.ok(Object.isFrozen(EXPECTED_TOOLS), "EXPECTED_TOOLS must be frozen");
});

await check("gmail tool is wired with its full action schema", () => {
  assert.ok("gmail" in tools, "gmail tool is missing");
  assert.match(tools.gmail.description, /approval/i);
  assert.equal(
    tools.gmail.inputSchema.safeParse({ action: "send", account: "a@b.c", to: "x@y.z" }).success,
    true
  );
  assert.equal(tools.gmail.inputSchema.safeParse({ action: "nope" }).success, false);
});

await check("skill returns the instructions and places package files in the sandbox", async () => {
  const placed = [];
  const t = buildTools({
    ...deps,
    skill: async () => ({
      name: "demo",
      description: "Demo package",
      body: "Run scripts/run.py.",
      files: [
        { path: "SKILL.md", bytes: 10 },
        { path: "scripts/run.py", bytes: 12 },
      ],
    }),
    materializeSkill: async (name) => {
      placed.push(name);
      return "Skill files (2) are in /home/user/.blip/skills/demo. Run its scripts from there with exec.";
    },
  }).skill;
  const out = await t.execute({ name: "demo" }, { toolCallId: "c-skill" });
  assert.match(out, /Run scripts\/run\.py/);
  assert.match(out, /scripts\/run\.py \(12 B\)/);
  assert.match(out, /\.blip\/skills\/demo/);
  assert.deepEqual(placed, ["demo"]);
});

await check("a sandbox write failure still returns the skill instructions", async () => {
  const t = buildTools({
    ...deps,
    skill: async () => ({
      name: "demo",
      description: "Demo package",
      body: "Follow these steps.",
      files: [{ path: "SKILL.md", bytes: 10 }],
    }),
    materializeSkill: async () => {
      throw new Error("sandbox offline");
    },
  }).skill;
  const out = await t.execute({ name: "demo" }, { toolCallId: "c-skill" });
  assert.match(out, /Follow these steps/);
  assert.match(out, /could not be placed in the sandbox/);
});

await check("write_file reports writing and settles at 1", async () => {
  const calls = [];
  const t = buildTools({
    ...deps,
    writeFile: async (path, content, append) => {
      calls.push([path, content, append]);
      return "Wrote notes.md (5 bytes).";
    },
  }).write_file;
  const out = await t.execute({ path: "notes.md", content: "hello" }, { toolCallId: "c-write" });
  assert.match(out, /Wrote notes\.md/);
  assert.deepEqual(calls, [["notes.md", "hello", false]]);
});

await check("exec does not opt into rerun (it writes)", () => {
  assert.equal("recovery" in tools.exec, false);
});

await check("lookup_online opts into rerun (read-only)", () => {
  assert.equal(tools.lookup_online.recovery, "rerun");
});

await check("every tool has a substantive, em-dash-free description", () => {
  for (const [name, t] of Object.entries(tools)) {
    assert.ok(typeof t.description === "string" && t.description.length > 40, `${name} description too short`);
    assert.equal(t.description.includes("\u2014"), false, `${name} description contains an em dash`);
  }
});

await check("lookup_online states the default cap and the truncation path", () => {
  const d = tools.lookup_online.description;
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

await check("lookup_online reports the query while searching and settles at 1", async () => {
  const fake = recordingDeps();
  await buildTools(fake.deps).lookup_online.execute(
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

await check("every tool's final progress is fraction 1, and phases use the fixed vocabulary", async () => {
  const allowed = new Set(["searching", "running", "snapshotting", "scheduling", "restoring", "delegating", "writing"]);
  const runs = [
    ["exec", { cmd: "pwd" }],
    ["lookup_online", { query: "docs" }],
    ["schedule_task", { title: "j", instructions: "i" }],
    ["write_file", { path: "notes.md", content: "hello" }],
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

// Task 32: the delegate tool, which is what makes src/child.ts reachable.
// The runner itself lives in src/agent.ts (it needs the DO), so everything here
// is the part that can be proven without one: the name policy that decides how
// many children exist, the report ceiling, the widget agreement, and the refusal
// text the model reads when the fan-out cap is hit.

const delegateDeps = (report = "found: X came from https://example.com") => {
  const seen = [];
  return {
    seen,
    deps: {
      ...deps,
      delegate: async (input, onProgress) => {
        seen.push(input);
        onProgress?.({ phase: "delegating", message: `sub-agent ${input.name} started`, fraction: null });
        return report;
      },
      progress: () => {},
    },
  };
};

await check("delegate reuses one sub-agent per goal, so 50 calls cannot mean 50 children", async () => {
  const fake = delegateDeps();
  const t = buildTools(fake.deps).delegate;
  const names = new Set();
  for (let i = 0; i < 50; i++) {
    await t.execute({ goal: "Summarize what durable objects are" }, { toolCallId: `c${i}` });
  }
  assert.equal(fake.seen.length, 50, "one runner call per tool call");
  for (const call of fake.seen) names.add(call.name);
  assert.equal(names.size, 1, `same goal produced ${names.size} sub-agent names`);
});

await check("childNameFor is deterministic, readable, and a legal Durable Object name", () => {
  const goal = "Summarize Durable Objects";
  assert.equal(childNameFor(goal), childNameFor(goal));
  assert.match(childNameFor(goal), /^sub-summarize-durable-objects-[a-z0-9]+$/);
  assert.notEqual(childNameFor(goal), childNameFor("Summarize R2"), "same suffix for different goals");
  assert.match(childNameFor(goal), /^[A-Za-z0-9_-]{1,64}$/);
  const long = childNameFor("x".repeat(2000));
  assert.ok(long.length <= 64, `derived name is ${long.length} chars`);
  assert.match(long, /^[A-Za-z0-9_-]{1,64}$/);
});

await check("delegate hands the runner the parent's routing, not a guess", async () => {
  const fake = delegateDeps();
  await buildTools(fake.deps).delegate.execute(
    { goal: "check the logs", focus: "only the last hour" },
    { toolCallId: "call-77" }
  );
  const input = fake.seen[0];
  assert.equal(input.parentCallId, "call-77", "the child must report onto this card");
  assert.equal(input.goal, "check the logs");
  assert.equal(input.focus, "only the last hour");
});

await check("the report is capped at CHILD_REPORT_BYTES with a truncation note", async () => {
  assert.equal(CHILD_REPORT_BYTES, 6000);
  const fake = delegateDeps("r".repeat(CHILD_REPORT_BYTES + 2500));
  const out = await buildTools(fake.deps).delegate.execute(
    { goal: "long one" },
    { toolCallId: "c" }
  );
  assert.match(out, /\[truncated 2500 chars\]/);
  assert.ok(out.length < CHILD_REPORT_BYTES + 200, `capped output is ${out.length} chars`);
});

await check("delegate reports delegating and settles at 1", async () => {
  const calls = [];
  const t = buildTools({
    ...deps,
    delegate: async () => "done",
    progress: (toolCallId, p) => calls.push({ toolCallId, ...p }),
  }).delegate;
  await t.execute({ goal: "summarize R2" }, { toolCallId: "c-deleg" });
  assert.equal(calls[0].toolCallId, "c-deleg");
  assert.equal(calls[0].phase, "delegating");
  assert.equal(calls[0].fraction, null);
  assert.equal(calls.at(-1).fraction, 1);
});

await check("delegate is a write, so it does not opt into rerun", () => {
  assert.equal("recovery" in tools.delegate, false);
});

await check("no runner means no delegate tool, not a tool that always fails", () => {
  // A child is built from deps with no runner. Handing it a `delegate` that
  // throws on every call would still tell the model it can spawn.
  const built = buildTools(deps);
  assert.equal("delegate" in built, false);
  assert.deepEqual(Object.keys(built), [
    "exec",
    "lookup_online",
    "schedule_task",
    "mcp_call",
    "skill",
    "skill_install",
    "write_file",
  ]);
});

await check("the fan-out refusal names the cap and the way out", () => {
  const text = childBusyRefusal(3);
  assert.equal(text, "3 sub-agents already running; wait or ask for fewer");
  assert.equal(text.includes("\u2014"), false);
});

await check("every wired tool has a widget, so no card renders as a generic Tool", () => {
  for (const name of EXPECTED_TOOLS) {
    const w = TOOL_WIDGET[name];
    assert.ok(w, `TOOL_WIDGET has no entry for ${name}`);
    assert.ok(typeof w.label === "string" && w.label.length > 0, `${name} label`);
    assert.ok(typeof w.state === "string" && w.state.length > 0, `${name} state`);
  }
});

await check("the capability table now claims sub-agents, and the child set still does not", () => {
  assert.match(capabilitiesText(EXPECTED_TOOLS), /^- Sub-agents:/m);
  const row = capabilityList(EXPECTED_TOOLS).find((c) => c.id === "sub-agents");
  assert.equal(row.wired, true);
  assert.match(row.detail, /delegate tool/);
  assert.doesNotMatch(capabilitiesText(CHILD_TOOL_NAMES), /Sub-agents/);
  assert.equal(
    capabilityList(CHILD_TOOL_NAMES).find((c) => c.id === "sub-agents").wired,
    false
  );
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`tools: ${failures.length} failed`);
  process.exit(1);
}
