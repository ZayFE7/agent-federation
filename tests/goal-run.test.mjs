// Goal-run helpers: exec allowlist, write/MCP side effects, the step prompt,
// usage aggregation, and operation-chain completion. Pure functions only.
// `node tests/goal-run.test.mjs`. Silent on success, exit 1 on failure.

import assert from "node:assert/strict";
import {
  MAX_STEP_PROMPT_CHARS,
  aggregateUsage,
  buildStepPrompt,
  classifyToolEffect,
  goalRunComplete,
} from "../src/goal-run.ts";

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

const readOnlyCommands = [
  "ls",
  "ls -la",
  "pwd",
  "cat file",
  "head -n 5 file",
  "tail -n 2 file",
  "wc -l file",
  "grep x file",
  "grep 'a>b' file",
  'grep "a|b" file',
  "rg x .",
  "find . -name x",
  'find . -name "*.ts"',
  "stat file",
  "file data.bin",
  "du -sh .",
  "df -h",
  "uname -a",
  "whoami",
  "date",
  "date -u +%s",
  "git status",
  "git status --porcelain",
  "git diff",
  "git log --oneline",
  "git show HEAD",
];

const sideEffectingCommands = [
  "ls > out",
  "cat x >> out",
  "cat x < in",
  "ls 2>/dev/null",
  "python3 x.py",
  "rm x",
  "find . -delete",
  "find . -name x -exec rm {} ;",
  "find . -name x -fprint out",
  "git commit -m x",
  "git branch new",
  "git log --output=out.txt",
  "git show --ext-diff HEAD",
  "npm test",
  "ls | sh",
  "cat x && python3 y.py",
  "cat x; rm y",
  "ls || rm x",
  "echo hi",
  "date 010100002026",
  "date -s 2026-01-01",
  "rg --pre cat x",
  "ls $(rm x)",
  "ls `rm x`",
  "cat x\nrm y",
  "(ls)",
  "",
];

await check("the exec allowlist treats every segment as read-only", () => {
  for (const command of readOnlyCommands) {
    assert.equal(
      classifyToolEffect("exec", { cmd: command }),
      false,
      `${command} should be read-only`
    );
  }
});

await check("redirection, pipelines, sequencing, and non-allowlisted commands are side-effecting", () => {
  for (const command of sideEffectingCommands) {
    assert.equal(
      classifyToolEffect("exec", { cmd: command }),
      true,
      `${command} should be side-effecting`
    );
  }
});

await check("exec accepts a bare string command and fails closed on missing input", () => {
  assert.equal(classifyToolEffect("exec", "ls -la"), false);
  assert.equal(classifyToolEffect("exec", {}), true);
  assert.equal(classifyToolEffect("exec", null), true);
  assert.equal(classifyToolEffect("exec", { cmd: ["ls", "-la"] }), false);
});

await check("write_file is side-effecting unless a finished identical write exists", () => {
  const input = { path: "notes.md", content: "hello" };
  assert.equal(classifyToolEffect("write_file", input), true);
  assert.equal(
    classifyToolEffect("write_file", { ...input, append: true }),
    true
  );
  assert.equal(
    classifyToolEffect("write_file", {
      ...input,
      ledger: [{ status: "finished", path: "notes.md", content: "hello" }],
    }),
    false
  );
  assert.equal(
    classifyToolEffect("write_file", {
      ...input,
      ledger: [{ status: "intent", path: "notes.md", content: "hello" }],
    }),
    true
  );
  assert.equal(
    classifyToolEffect("write_file", {
      ...input,
      ledger: [{ status: "finished", path: "other.md", content: "hello" }],
    }),
    true
  );
  assert.equal(
    classifyToolEffect("write_file", {
      ...input,
      content_sha256: "abc",
      ledger: [
        { status: "finished", path: "notes.md", content_sha256: "abc" },
      ],
    }),
    false
  );
  assert.equal(
    classifyToolEffect("write_file", {
      ...input,
      input_hash: "h1",
      ledger: [{ status: "finished", path: "notes.md", input_hash: "h2" }],
    }),
    true
  );
  assert.equal(
    classifyToolEffect("write_file", {
      ...input,
      input_hash: "h1",
      ledger: [{ status: "finished", input_hash: "h1" }],
    }),
    false
  );
  assert.equal(
    classifyToolEffect("write_file", input, null, [
      { status: "finished", path: "notes.md", content: "hello" },
    ]),
    false
  );
  assert.equal(
    classifyToolEffect("write_file", {
      path: "notes.md",
      content: "hello",
      prior: { status: "finished", path: "notes.md", content: "hello" },
    }),
    false
  );
  assert.equal(
    classifyToolEffect("write_file", input, [
      { status: "finished", path: "notes.md", content: "hello" },
    ]),
    false
  );
});

await check("mcp_call is side-effecting unless the exact server/tool pair is read-only", () => {
  const input = { server: "calendar", tool: "list_events" };
  assert.equal(classifyToolEffect("mcp_call", input), true);
  assert.equal(classifyToolEffect("mcp_call", input, ["calendar/list_events"]), false);
  assert.equal(
    classifyToolEffect("mcp_call", input, [{ server: "calendar", tool: "list_events" }]),
    false
  );
  assert.equal(
    classifyToolEffect("mcp_call", input, new Set(["calendar/list_events"])),
    false
  );
  assert.equal(
    classifyToolEffect("mcp_call", input, (server, tool) => `${server}/${tool}` === "calendar/list_events"),
    false
  );
  assert.equal(
    classifyToolEffect("mcp_call", input, { "calendar/list_events": true }),
    false
  );
  assert.equal(classifyToolEffect("mcp_call", input, ["calendar/create_event"]), true);
  assert.equal(classifyToolEffect("mcp_call", input, ["other/list_events"]), true);
  assert.equal(classifyToolEffect("mcp_call", {}, ["calendar/list_events"]), true);
});

await check("the explicit tool lists match the side-effect policy", () => {
  for (const tool of ["delegate", "skill_install", "schedule_task", "goal_create", "unknown_tool"]) {
    assert.equal(classifyToolEffect(tool, {}), true, `${tool} should be side-effecting`);
  }
  for (const tool of ["lookup_online", "skill"]) {
    assert.equal(classifyToolEffect(tool, {}), false, `${tool} should be read-only`);
  }
});

await check("the step prompt contains the goal, step, digest, instructions, and budget", () => {
  const prompt = buildStepPrompt({
    goal: {
      title: "Ship the report",
      brief: "PLAIN_BRIEF",
      success_criteria: "CRITERIA_X",
      planner_reasoning: "SECRET_PLANNER_REASONING",
      verifier_reasoning: "SECRET_VERIFIER_REASONING",
    },
    step: {
      title: "Write it",
      kind: "work",
      objective: "OBJ_Y",
      done_when: "DONE_Z",
      checks_json: JSON.stringify([{ type: "file", path: "out/result.md" }]),
    },
    completed: [{ title: "Setup", result: "wrote a file", evidence: ["out/setup"] }],
    instructions: ["Use UTC."],
    remaining_budget: {
      steps_left: 2,
      tool_calls_left: 5,
      active_ms_left: 120000,
      tokens_left: 1000,
    },
  });
  for (const needle of [
    "PLAIN_BRIEF",
    "CRITERIA_X",
    "OBJ_Y",
    "DONE_Z",
    "out/result.md",
    "Setup",
    "wrote a file",
    "out/setup",
    "Use UTC.",
    "2",
    "5",
    "2 min",
    "1000",
    "untrusted data",
    "FINAL REPORT",
    "Never claim success without evidence",
  ]) {
    assert.ok(prompt.includes(needle), `missing ${needle}`);
  }
  for (const forbidden of [
    "SECRET_PLANNER_REASONING",
    "SECRET_VERIFIER_REASONING",
    "goal_create",
    "goal_status",
    "goal_control",
    "planner",
    "verifier",
  ]) {
    assert.equal(prompt.includes(forbidden), false, `prompt leaked ${forbidden}`);
  }
});

await check("the step prompt computes remaining budget from goal budget and usage", () => {
  const prompt = buildStepPrompt({
    goal: { brief: "b", success_criteria: "c" },
    step: { objective: "o", done_when: "d" },
    budget: {
      max_steps: 4,
      max_tool_calls: 10,
      max_active_ms: 600000,
      max_tokens: 1000,
    },
    usage: { steps: 1, tool_calls: 3, active_ms: 60000, tokens: 250 },
  });
  assert.match(prompt, /work steps remaining: 3/);
  assert.match(prompt, /tool calls remaining: 7/);
  assert.match(prompt, /active time remaining: 9 min/);
  assert.match(prompt, /tokens remaining \(best effort\): 750/);
  assert.match(prompt, /20 tool calls, 10 min active/);
});

await check("a max-shaped remaining_budget is reduced by usage, not shown as remaining", () => {
  const prompt = buildStepPrompt({
    goal: { brief: "b", success_criteria: "c" },
    step: { objective: "o", done_when: "d" },
    remaining_budget: {
      max_steps: 10,
      max_tool_calls: 50,
      max_active_ms: 3600000,
      max_tokens: 5000,
    },
    usage: { steps: 4, tool_calls: 20, active_ms: 1800000, tokens: 2000 },
  });
  assert.match(prompt, /work steps remaining: 6/);
  assert.match(prompt, /tool calls remaining: 30/);
  assert.match(prompt, /active time remaining: 30 min/);
  assert.match(prompt, /tokens remaining \(best effort\): 3000/);
});

await check("an oversized step prompt is cut with an explicit marker", () => {
  const prompt = buildStepPrompt({
    goal: { brief: "x".repeat(40000), success_criteria: "y".repeat(20000) },
    step: { objective: "z".repeat(20000), done_when: "w".repeat(5000) },
  });
  assert.ok(prompt.length <= MAX_STEP_PROMPT_CHARS);
  assert.match(prompt, /truncated/);
  assert.match(prompt, /FINAL REPORT/);
  assert.match(prompt, /Next recommended step/);
});

await check("usage sums across usage objects, JSON rows, and camelCase fields", () => {
  const usage = aggregateUsage([
    {
      status: "done",
      usage: { tokens: 100, model_steps: 1, tool_calls: 2, active_ms: 1000 },
    },
    {
      status: "done",
      usage_json: JSON.stringify({
        totalTokens: 50,
        modelSteps: 2,
        toolCalls: 1,
        activeMs: 500,
      }),
    },
    {
      status: "done",
      usage_json: JSON.stringify({ inputTokens: 10, outputTokens: 5 }),
    },
    { status: "done" },
  ]);
  assert.deepEqual(usage, {
    steps: 0,
    tool_calls: 3,
    active_ms: 1500,
    tokens: 165,
    model_steps: 3,
    replans: 0,
  });
  assert.deepEqual(aggregateUsage(null), {
    steps: 0,
    tool_calls: 0,
    active_ms: 0,
    tokens: 0,
    model_steps: 0,
    replans: 0,
  });
});

await check("a run chain completes only when every operation is final and no approval is parked", () => {
  assert.equal(goalRunComplete([{ status: "done" }, { status: "failed" }], false), true);
  assert.equal(goalRunComplete([{ status: "done" }], true), false);
  assert.equal(goalRunComplete([{ status: "running" }], false), false);
  assert.equal(goalRunComplete([{ status: "pending_approval" }], false), false);
  assert.equal(goalRunComplete([{ status: "done" }, { status: "running" }], false), false);
  assert.equal(goalRunComplete([], false), false);
  assert.equal(goalRunComplete(null, false), false);
  assert.equal(goalRunComplete([{ status: "unknown" }], false), false);
  assert.equal(goalRunComplete([{ status: "aborted" }], false), true);
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`goal-run: ${failures.length} failed`);
  process.exit(1);
}
