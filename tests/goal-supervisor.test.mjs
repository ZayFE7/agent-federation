// Goal supervisor: planning, claiming, completion, verification, pause, and
// signature checks against a real SQLite goal store.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { GoalStore } from "../src/goal-store.ts";
import { GoalSupervisor } from "../src/goal-supervisor.ts";

const failures = [];
async function checkAsync(name, fn) {
  try {
    await fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

function makeStore() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query, ...bindings) {
      const parts = query.split("?");
      if (parts.length !== bindings.length + 1) throw new Error("placeholder mismatch");
      return { results: db.prepare(parts.join("?")).all(...bindings) };
    },
  };
  const store = new GoalStore(sql);
  store.ensureSchema();
  return store;
}

let clock = 1_000_000;
let seq = 0;
const starts = [];
const store = makeStore();
const supervisor = new GoalSupervisor({
  store,
  now: () => clock,
  id: () => `id${++seq}abcde`.padEnd(12, "x"),
  sessions: {
    async startGoalStep(input) {
      starts.push(input);
      return { ok: true };
    },
    async abortGoalRun() {
      return { aborted: true, sideEffects: false };
    },
  },
  async plan() {
    return {
      usedFallback: false,
      steps: [
        {
          kind: "work",
          title: "Make the file",
          objective: "Write result.md",
          done_when: "result.md exists",
          checks: [{ type: "file", path: "result.md" }],
          max_attempts: 2,
        },
      ],
    };
  },
  async verify() {
    return {
      verdict: "done",
      reason: "result.md exists",
      feedback: null,
      evidence_used: ["file:result.md"],
      goal_done: true,
    };
  },
});

let goal;
await checkAsync("create plans and starts one step", async () => {
  goal = await supervisor.createGoal({
    title: "Report",
    brief: "Make result.md",
    success_criteria: "result.md exists",
    session_id: "s1",
  });
  assert.equal(goal.status, "planning");
  await supervisor.tick();
  const current = store.get(goal.id);
  assert.equal(current.status, "active");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].goalId, goal.id);
  assert.match(starts[0].prompt, /Make result\.md/);
});

await checkAsync("a tick during an in-flight verification does not block the goal", async () => {
  const stepId = starts[0].stepId;
  store.updateStep(stepId, { status: "verifying", updated_at: clock });
  await supervisor.tick();
  assert.equal(store.get(goal.id).status, "active");
  assert.equal(store.listAttention(10).length, 0);
});

await checkAsync("a stale verification is requeued instead of blocking forever", async () => {
  const stepId = starts[0].stepId;
  store.updateStep(stepId, {
    status: "verifying",
    updated_at: clock - 16 * 60 * 1000,
  });
  store.update(goal.id, { status: "verifying", updated_at: clock });
  await supervisor.tick();
  const current = store.get(goal.id);
  assert.equal(current.status, "active");
  assert.equal(store.getStep(stepId).status, "queued");
  assert.ok(store.listAttention(10).length === 0);
});

await checkAsync("completion passes verification and completes the goal", async () => {
  const input = starts[0];
  await supervisor.completeStep({
    runId: input.runId,
    leaseToken: input.leaseToken,
    goalId: input.goalId,
    stepId: input.stepId,
    status: "done",
    result: "created",
    evidence: { items: [{ kind: "file", path: "result.md", status: "ok" }] },
    usage: { tokens: 10 },
    tools: [],
  });
  const current = store.get(goal.id);
  assert.equal(current.status, "done");
  assert.equal(store.listAttention(10).length, 1);
});

await checkAsync("a duplicate completion is ignored", async () => {
  const input = starts[0];
  await supervisor.completeStep({
    runId: input.runId,
    leaseToken: input.leaseToken,
    goalId: input.goalId,
    stepId: input.stepId,
    status: "done",
    result: "again",
    evidence: {},
    usage: {},
    tools: [],
  });
  assert.equal(store.get(goal.id).status, "done");
});

await checkAsync("paused goals start nothing", async () => {
  const second = await supervisor.createGoal({
    title: "Paused",
    brief: "Do nothing",
    success_criteria: "nothing",
    session_id: "s2",
  });
  await supervisor.tick();
  const startsBefore = starts.length;
  await supervisor.control(second.id, "pause");
  await supervisor.tick();
  assert.equal(starts.length, startsBefore);
});

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log("goal supervisor: passed");
