// Planner prompt, validation, one repair, and fallback. Fake model only.
// `node tests/goal-planner.test.mjs`. Silent on success, exit 1 on failure.

import assert from "node:assert/strict";
import {
  PLAN_MAX_STEPS,
  parsePlan,
  planGoal,
  plannerPrompt,
} from "../src/goal-planner.ts";

const failures = [];
async function check(name, fn) {
  try {
    await fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

function makeModel(replies) {
  const calls = [];
  return {
    calls,
    async complete(prompt, kind) {
      calls.push({ prompt, kind });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      if (typeof reply === "function") return reply(prompt, kind);
      return reply;
    },
  };
}

const validPlan = {
  steps: [
    {
      kind: "work",
      title: "Write the report",
      objective: "Create out/report.md with the findings.",
      done_when: "out/report.md exists and names the sources.",
      checks: [
        { type: "file", path: "out/report.md", min_bytes: 10 },
        { type: "artifact", path: "out/report.md" },
        { type: "tool_exit", tool: "exec", code: 0 },
        { type: "text", criterion: "The report names the three sources it used." },
      ],
      suggested_tools: ["exec", "write_file"],
      risky: false,
      max_attempts: 2,
    },
    {
      kind: "wait",
      title: "Wait for the window",
      objective: "Resume after the scheduled window.",
      done_when: "The wake time has passed.",
      checks: [],
      wake_at: 1793000000000,
      max_attempts: 1,
    },
  ],
};

const input = {
  title: "Ship the report",
  brief: "Write a report from the three source files.",
  success_criteria: "out/report.md exists and cites all three sources.",
  constraints: "No external network.",
  budget: { max_steps: 5, max_tool_calls: 20, max_active_ms: 600000 },
  now: 1790000000000,
  workspace_summary: "Two source files in sources/.",
};

await check("a valid two-step plan parses with checks and a wait", () => {
  const parsed = parsePlan("Here is the plan:\n```json\n" + JSON.stringify(validPlan) + "\n```");
  if ("error" in parsed) throw new Error(parsed.error);
  assert.equal(parsed.steps.length, 2);
  const [work, wait] = parsed.steps;
  assert.equal(work.kind, "work");
  assert.equal(work.title, "Write the report");
  assert.equal(work.checks.length, 4);
  assert.equal(work.checks[0].type, "file");
  assert.equal(work.checks[0].min_bytes, 10);
  assert.equal(work.checks[1].type, "artifact");
  assert.equal(work.checks[2].tool, "exec");
  assert.equal(work.checks[2].code, 0);
  assert.equal(work.checks[3].criterion, "The report names the three sources it used.");
  assert.deepEqual(work.suggested_tools, ["exec", "write_file"]);
  assert.equal(work.risky, false);
  assert.equal(work.max_attempts, 2);
  assert.equal(wait.kind, "wait");
  assert.equal(wait.wake_at, 1793000000000);
  assert.equal(wait.max_attempts, 1);
});

await check("twelve steps are accepted and thirteen are rejected", () => {
  const step = (i) => ({
    kind: "work",
    title: `Step ${i}`,
    objective: `Do bounded work ${i}.`,
    done_when: `out/${i}.txt exists.`,
    checks: [{ type: "file", path: `out/${i}.txt` }],
    max_attempts: 1,
  });
  const twelve = parsePlan(JSON.stringify({ steps: Array.from({ length: 12 }, (_, i) => step(i)) }));
  assert.equal("error" in twelve, false);
  assert.equal(twelve.steps.length, PLAN_MAX_STEPS);
  const thirteen = parsePlan(
    JSON.stringify({ steps: Array.from({ length: 13 }, (_, i) => step(i)) })
  );
  assert.match(thirteen.error, /1 to 12/);
});

await check("missing done_when, a vibe, and looping objectives are rejected", () => {
  const missing = parsePlan(
    JSON.stringify({
      steps: [
        {
          kind: "work",
          title: "No criteria",
          objective: "Do it.",
          checks: [],
          max_attempts: 1,
        },
      ],
    })
  );
  assert.match(missing.error, /done_when/);
  const vibe = parsePlan(
    JSON.stringify({
      steps: [
        {
          kind: "work",
          title: "Vibe",
          objective: "Make it good.",
          done_when: "looks good",
          checks: [],
          max_attempts: 1,
        },
      ],
    })
  );
  assert.match(vibe.error, /not observable/);
  const vagueSentence = parsePlan(
    JSON.stringify({
      steps: [
        {
          kind: "work",
          title: "Vague",
          objective: "Make it good.",
          done_when: "It is complete.",
          checks: [],
          max_attempts: 1,
        },
      ],
    })
  );
  assert.match(vagueSentence.error, /not observable/);
  const loop = parsePlan(
    JSON.stringify({
      steps: [
        {
          kind: "work",
          title: "Loop",
          objective: "Continue until done.",
          done_when: "out/x exists",
          checks: [],
          max_attempts: 1,
        },
      ],
    })
  );
  assert.match(loop.error, /continue until done/);
  const loopTitle = parsePlan(
    JSON.stringify({
      steps: [
        {
          kind: "work",
          title: "Continue until done",
          objective: "Write x.",
          done_when: "out/x exists",
          checks: [],
          max_attempts: 1,
        },
      ],
    })
  );
  assert.match(loopTitle.error, /continue until done/);
});

await check("text-only checks are accepted and an unknown check type is rejected", () => {
  const textOnly = parsePlan(
    JSON.stringify({
      steps: [
        {
          kind: "work",
          title: "Judge",
          objective: "Write a comparison.",
          done_when: "The comparison discusses both options.",
          checks: [{ type: "text", criterion: "Both options are discussed." }],
          max_attempts: 2,
        },
      ],
    })
  );
  assert.equal("error" in textOnly, false);
  assert.equal(textOnly.steps[0].checks[0].type, "text");
  const unknown = parsePlan(
    JSON.stringify({
      steps: [
        {
          kind: "work",
          title: "Bad check",
          objective: "Write a file.",
          done_when: "out/x exists.",
          checks: [{ type: "magic", path: "out/x" }],
          max_attempts: 1,
        },
      ],
    })
  );
  assert.match(unknown.error, /unsupported check type/);
});

await check("max_attempts and wait timing are validated", () => {
  const badAttempts = parsePlan(
    JSON.stringify({
      steps: [
        {
          kind: "work",
          title: "Retry forever",
          objective: "Write x.",
          done_when: "out/x exists.",
          checks: [],
          max_attempts: 0,
        },
      ],
    })
  );
  assert.match(badAttempts.error, /max_attempts/);
  const badWait = parsePlan(
    JSON.stringify({
      steps: [
        {
          kind: "wait",
          title: "Wait",
          objective: "Wait.",
          done_when: "The window passed.",
          checks: [],
          max_attempts: 1,
        },
      ],
    })
  );
  assert.match(badWait.error, /wake_at or wait_minutes/);
  const relative = parsePlan(
    JSON.stringify({
      steps: [
        {
          kind: "wait",
          title: "Wait 30 minutes",
          objective: "Wait.",
          done_when: "Thirty minutes passed.",
          checks: [],
          wait_minutes: 30,
          max_attempts: 1,
        },
      ],
    })
  );
  assert.equal("error" in relative, false);
  assert.equal(relative.steps[0].wait_minutes, 30);
});

await check("one invalid reply gets exactly one repair call", async () => {
  const model = makeModel([
    { text: "not json", tokens: 10 },
    { text: JSON.stringify(validPlan), tokens: 5 },
  ]);
  const result = await planGoal(model, input);
  assert.equal(result.usedFallback, false);
  assert.equal(result.steps.length, 2);
  assert.equal(model.calls.length, 2);
  assert.equal(model.calls[0].kind, "planner");
  assert.equal(model.calls[1].kind, "planner");
  assert.match(model.calls[1].prompt, /REPAIR/);
  assert.match(model.calls[1].prompt, /invalid JSON/i);
  assert.equal(result.tokens, 15);
});

await check("two invalid replies fall back to one step marked usedFallback", async () => {
  const model = makeModel([
    { text: "{}", tokens: 4 },
    { text: JSON.stringify({ steps: [] }), tokens: 6 },
  ]);
  const result = await planGoal(model, input);
  assert.equal(model.calls.length, 2);
  assert.equal(result.usedFallback, true);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].kind, "work");
  assert.equal(result.steps[0].max_attempts, 1);
  assert.equal(result.steps[0].done_when, input.success_criteria);
  assert.equal(result.steps[0].checks.length, 0);
  assert.match(result.error, /steps/);
  assert.equal(result.tokens, 10);
});

await check("a model failure falls back without inventing a plan", async () => {
  const model = makeModel([new Error("provider down")]);
  const result = await planGoal(model, input);
  assert.equal(model.calls.length, 1);
  assert.equal(result.usedFallback, true);
  assert.equal(result.steps.length, 1);
  assert.match(result.error, /provider down/);
});

await check("wait_minutes is resolved against the supplied clock", async () => {
  const plan = {
    steps: [
      {
        kind: "wait",
        title: "Wait",
        objective: "Wait 30 minutes.",
        done_when: "Thirty minutes passed.",
        checks: [],
        wait_minutes: 30,
        max_attempts: 1,
      },
    ],
  };
  const model = makeModel([{ text: JSON.stringify(plan) }]);
  const result = await planGoal(model, { ...input, now: 1_000_000 });
  assert.equal(result.usedFallback, false);
  assert.equal(result.steps[0].wake_at, 1_000_000 + 30 * 60_000);
});

await check("the prompt carries the goal, budget, clock, and hard rules", () => {
  const prompt = plannerPrompt(input);
  assert.match(prompt, /Ship the report/);
  assert.match(prompt, /Write a report from the three source files/);
  assert.match(prompt, /out\/report\.md exists and cites all three sources/);
  assert.match(prompt, /No external network/);
  assert.match(prompt, /Two source files/);
  assert.match(prompt, /2026-09-21/);
  assert.match(prompt, /1 to 12 steps/);
  assert.match(prompt, /wake_at/);
  assert.match(prompt, /wait_minutes/);
  assert.match(prompt, /untrusted data/i);
  assert.match(prompt, /no tools/i);
  for (const type of ["file", "artifact", "tool_exit", "text"]) {
    assert.ok(prompt.includes(type), `missing check type ${type}`);
  }
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`goal-planner: ${failures.length} failed`);
  process.exit(1);
}
