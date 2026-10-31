// Verifier tests: deterministic-first, fail-closed parsing, evidence citations,
// and the last-step replan rule. No model or network is used.
// `node tests/goal-verifier.test.mjs`. Silent on success, exit 1 on failure.

import assert from "node:assert/strict";
import {
  deterministicChecks,
  parseVerdict,
  verifierPrompt,
  verifyStep,
} from "../src/goal-verifier.ts";

const failures = [];
async function check(name, fn) {
  try {
    await fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

function makeModel(reply) {
  const calls = [];
  return {
    calls,
    async complete(prompt, kind) {
      calls.push({ prompt, kind });
      if (reply instanceof Error) throw reply;
      return typeof reply === "function" ? reply(prompt, kind) : reply;
    },
  };
}

function evidence(items, extra = {}) {
  return {
    run_id: "run1",
    items,
    missing: [],
    mismatches: [],
    errors: [],
    truncated: false,
    omitted: 0,
    bytes: 0,
    cap_bytes: 32768,
    ...extra,
  };
}

const goal = {
  title: "Ship the report",
  brief: "Write a report from the three sources.",
  success_criteria: "out/report.md exists and cites the three sources.",
};
const step = {
  title: "Write the report",
  objective: "Create out/report.md.",
  done_when: "out/report.md exists and cites the sources.",
};

const checks = [
  { type: "file", path: "out/report.md", min_bytes: 1 },
  { type: "artifact", path: "out/report.md" },
  { type: "tool_exit", tool: "exec", code: 0 },
  { type: "text", criterion: "The report names all three sources." },
];

const allPassingItems = [
  {
    index: 0,
    kind: "file",
    label: "file:out/report.md",
    path: "out/report.md",
    status: "ok",
    detail: "42 bytes",
    exists: true,
    bytes: 42,
    sha256: "a".repeat(64),
  },
  {
    index: 1,
    kind: "artifact",
    label: "artifact:out/report.md",
    path: "out/report.md",
    status: "ok",
    detail: "artifact is attached",
    present: true,
  },
  {
    index: 2,
    kind: "tool_exit",
    label: "tool_exit:exec",
    tool: "exec",
    status: "ok",
    detail: "exit 0 matches the required 0",
    code: 0,
    expected_code: 0,
  },
  {
    index: 3,
    kind: "text",
    label: "text:The report names all three sources.",
    criterion: "The report names all three sources.",
    status: "delegated",
    detail: "judgment",
  },
];

await check("deterministic checks cover file, artifact, tool exit, and delegated text", () => {
  const results = deterministicChecks(checks, evidence(allPassingItems));
  assert.deepEqual(results.map((r) => r.status), ["pass", "pass", "pass", "delegated"]);
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, true]);
  assert.equal(results[3].detail.includes("judgment"), true);
});

await check("deterministic checks compare hashes and exit codes, not just a status flag", () => {
  const hashCheck = deterministicChecks(
    [{ type: "file", path: "out/report.md", sha256: "a".repeat(64) }],
    evidence([{ ...allPassingItems[0], sha256: "b".repeat(64), status: "ok" }])
  );
  assert.equal(hashCheck[0].ok, false);
  assert.match(hashCheck[0].detail, /does not match/);

  const exitCheck = deterministicChecks(
    [{ type: "tool_exit", tool: "exec", code: 0 }],
    evidence([{ ...allPassingItems[2], code: 3, status: "ok" }])
  );
  assert.equal(exitCheck[0].ok, false);
  assert.match(exitCheck[0].detail, /expected exit 0/);
});

await check("a failing deterministic check skips the model and asks for a retry", async () => {
  const model = makeModel({ text: "never called" });
  const missing = {
    ...allPassingItems[0],
    status: "missing",
    detail: "file does not exist",
    bytes: null,
    sha256: null,
  };
  const result = await verifyStep(model, {
    goal,
    step,
    checks: [checks[0]],
    evidence: evidence([missing], { missing: ["file:out/report.md: file does not exist"] }),
  });
  assert.equal(model.calls.length, 0);
  assert.equal(result.verdict, "retry");
  assert.equal(result.goal_done, false);
  assert.match(result.reason, /Deterministic check failed/);
  assert.deepEqual(result.evidence_used, ["file:out/report.md"]);
});

await check("a forbidden effect is blocked without a model call", async () => {
  const model = makeModel({ text: "never called" });
  const result = await verifyStep(model, {
    goal,
    step,
    checks: [{ type: "forbidden_effect", tool: "exec" }],
    evidence: evidence([
      {
        index: 0,
        kind: "forbidden_effect",
        label: "forbidden_effect:exec",
        tool: "exec",
        status: "mismatch",
        detail: "the forbidden effect occurred 1 time(s)",
        calls: 1,
      },
    ]),
  });
  assert.equal(model.calls.length, 0);
  assert.equal(result.verdict, "blocked");
  assert.match(result.reason, /forbidden effect/);
});

await check("an unknown check type fails closed before the model", async () => {
  const model = makeModel({ text: "never called" });
  const result = await verifyStep(model, {
    goal,
    step,
    checks: [{ type: "magic", path: "x" }],
    evidence: evidence([]),
  });
  assert.equal(model.calls.length, 0);
  assert.equal(result.verdict, "blocked");
  assert.match(result.reason, /unsupported check type/);
});

await check("invalid verifier JSON fails closed to blocked", async () => {
  const model = makeModel({ text: "I think it passed.", tokens: 9 });
  const result = await verifyStep(model, {
    goal,
    step,
    checks: [],
    evidence: evidence([]),
  });
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].kind, "verifier");
  assert.equal(result.verdict, "blocked");
  assert.match(result.reason, /invalid or ambiguous JSON/);
  assert.equal(result.tokens, 9);
});

await check("a pass without evidence citations fails closed", async () => {
  const model = makeModel({
    text: JSON.stringify({
      verdict: "pass",
      reason: "Looks done.",
      feedback: "",
      evidence_used: [],
      goal_done: false,
    }),
  });
  const result = await verifyStep(model, {
    goal,
    step,
    checks: [],
    evidence: evidence([]),
  });
  assert.equal(result.verdict, "blocked");
  assert.match(result.reason, /without citing any evidence/);
});

await check("a citation the verifier cannot see fails closed", async () => {
  const model = makeModel({
    text: JSON.stringify({
      verdict: "pass",
      reason: "Looks done.",
      evidence_used: ["file:invented.md"],
      goal_done: false,
    }),
  });
  const result = await verifyStep(model, {
    goal,
    step,
    checks: [checks[0]],
    evidence: evidence([allPassingItems[0]]),
  });
  assert.equal(result.verdict, "blocked");
  assert.match(result.reason, /could not see/);
});

await check("one invented citation blocks even beside a real one", async () => {
  const model = makeModel({
    text: JSON.stringify({
      verdict: "pass",
      reason: "Looks done.",
      evidence_used: ["file:out/report.md", "file:invented.md"],
      goal_done: false,
    }),
  });
  const result = await verifyStep(model, {
    goal,
    step,
    checks: [checks[0]],
    evidence: evidence([allPassingItems[0]]),
  });
  assert.equal(result.verdict, "blocked");
});

await check("a cited pass on a non-final step stays a pass", async () => {
  const model = makeModel({
    text: JSON.stringify({
      verdict: "pass",
      reason: "The file exists and the report is adequate.",
      feedback: "",
      evidence_used: ["file:out/report.md", "report"],
      goal_done: false,
    }),
    tokens: 12,
  });
  const result = await verifyStep(model, {
    goal,
    step,
    checks: [checks[0]],
    evidence: evidence([allPassingItems[0]]),
    report: "I wrote the report.",
    is_last: false,
  });
  assert.equal(result.verdict, "pass");
  assert.equal(result.goal_done, false);
  assert.equal(result.tokens, 12);
  assert.equal(result.deterministic.length, 1);
});

await check("the last step passing with goal_done false becomes replan, or blocks without budget", async () => {
  const reply = {
    text: JSON.stringify({
      verdict: "pass",
      reason: "The step is done.",
      feedback: "The broader goal still needs an index.",
      evidence_used: ["report"],
      goal_done: false,
    }),
  };
  const replan = await verifyStep(makeModel(reply), {
    goal,
    step,
    checks: [],
    evidence: evidence([]),
    is_last: true,
    can_replan: true,
  });
  assert.equal(replan.verdict, "replan");
  assert.match(replan.reason, /goal_done is false/);
  assert.equal(replan.goal_done, false);

  const blocked = await verifyStep(makeModel(reply), {
    goal,
    step,
    checks: [],
    evidence: evidence([]),
    is_last: true,
    can_replan: false,
  });
  assert.equal(blocked.verdict, "blocked");
  assert.match(blocked.reason, /replan budget is exhausted/);

  const alias = await verifyStep(makeModel(reply), {
    goal,
    step,
    checks: [],
    evidence: evidence([]),
    last_step: true,
    replans_left: 1,
  });
  assert.equal(alias.verdict, "replan");
});

await check("done requires goal_done and never precedes the final step", async () => {
  const done = await verifyStep(
    makeModel({
      text: JSON.stringify({
        verdict: "done",
        reason: "Everything is present.",
        evidence_used: ["file:out/report.md"],
        goal_done: true,
      }),
    }),
    {
      goal,
      step,
      checks: [checks[0]],
      evidence: evidence([allPassingItems[0]]),
      is_last: true,
    }
  );
  assert.equal(done.verdict, "done");
  assert.equal(done.goal_done, true);

  const contradictory = await verifyStep(
    makeModel({
      text: JSON.stringify({
        verdict: "done",
        reason: "Everything is present.",
        evidence_used: ["file:out/report.md"],
        goal_done: false,
      }),
    }),
    {
      goal,
      step,
      checks: [checks[0]],
      evidence: evidence([allPassingItems[0]]),
      is_last: true,
    }
  );
  assert.equal(contradictory.verdict, "blocked");

  const early = await verifyStep(
    makeModel({
      text: JSON.stringify({
        verdict: "done",
        reason: "Everything is present.",
        evidence_used: ["file:out/report.md"],
        goal_done: true,
      }),
    }),
    {
      goal,
      step,
      checks: [checks[0]],
      evidence: evidence([allPassingItems[0]]),
      is_last: false,
    }
  );
  assert.equal(early.verdict, "blocked");
});

await check("parseVerdict accepts all five verdicts and ignores extra fields", () => {
  for (const verdict of ["pass", "retry", "replan", "blocked", "done"]) {
    const parsed = parseVerdict(
      JSON.stringify({
        verdict,
        reason: "r",
        feedback: "f",
        evidence_used: ["file:x"],
        goal_done: verdict === "done",
        tools: ["exec"],
        budget: { max_tokens: 999999 },
      })
    );
    assert.equal(parsed.verdict, verdict);
    assert.equal(parsed.reason, "r");
    assert.equal(parsed.feedback, "f");
    assert.deepEqual(parsed.evidence_used, ["file:x"]);
    assert.equal("tools" in parsed, false);
    assert.equal("budget" in parsed, false);
  }
  assert.equal(parseVerdict("not JSON"), null);
  assert.equal(parseVerdict(JSON.stringify({ verdict: "approve", reason: "r" })), null);
  assert.equal(parseVerdict(JSON.stringify({ verdict: "pass", reason: "" })), null);
  assert.equal(
    parseVerdict(
      JSON.stringify({ verdict: "pass", reason: "r", evidence_used: "file:x" })
    ),
    null
  );
});

await check("the verifier prompt carries the goal, evidence, report, and rules", () => {
  const prompt = verifierPrompt({
    goal,
    step,
    checks,
    evidence: evidence(allPassingItems),
    report: "REPORT_TEXT",
    is_last: true,
  });
  assert.match(prompt, /Write a report from the three sources/);
  assert.match(prompt, /out\/report\.md exists and cites the three sources/);
  assert.match(prompt, /Create out\/report\.md/);
  assert.match(prompt, /out\/report\.md exists and cites the sources/);
  assert.match(prompt, /file:out\/report\.md/);
  assert.match(prompt, /REPORT_TEXT/);
  assert.match(prompt, /untrusted data/i);
  assert.match(prompt, /evidence_used/);
  assert.match(prompt, /goal_done/);
  assert.match(prompt, /no tools/i);
  assert.equal(prompt.includes("planner"), false);
});

await check("an oversized verifier prompt still keeps the required output shape", () => {
  const prompt = verifierPrompt({
    goal: { brief: "b".repeat(30000), success_criteria: "c".repeat(20000), title: "t" },
    step: { objective: "o".repeat(20000), done_when: "d".repeat(5000) },
    checks,
    evidence: evidence(allPassingItems),
    report: "r".repeat(10000),
  });
  assert.match(prompt, /truncated/);
  assert.match(prompt, /OUTPUT JSON/);
  assert.match(prompt, /goal_done/);
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`goal-verifier: ${failures.length} failed`);
  process.exit(1);
}
