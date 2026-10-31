// Goal store over real node:sqlite through the same SqlHandle adapter as
// tests/artifacts.test.mjs. Covers schema, CRUD, one live goal per session,
// atomic claims, capped JSON, events, attention, instructions, and pruning.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { GoalStore } from "../src/goal-store.ts";
import { DEFAULT_BUDGET } from "../src/goal-types.ts";

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
    console.log("  FAIL " + name);
  }
}

function freshStore() {
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
  return { store, sql };
}

function goalInput(over = {}) {
  return {
    title: "Ship report",
    brief: "Write the report",
    success_criteria: "report.md exists",
    session_id: "gs1",
    origin_session_id: "chat1",
    ...over,
  };
}

function stepInput(over = {}) {
  return {
    kind: "work",
    title: "Write it",
    objective: "Write report.md",
    done_when: "report.md exists",
    checks: [],
    max_attempts: 2,
    ...over,
  };
}

check("schema is idempotent", () => {
  const { store } = freshStore();
  store.ensureSchema();
  store.ensureSchema();
});

check("create fills planning status, default budget, zero usage, and origin source", () => {
  const { store } = freshStore();
  const row = store.create(goalInput(), 1000, "g1");
  assert.equal(row.status, "planning");
  assert.equal(row.paused, 0);
  assert.equal(row.plan_version, 0);
  assert.equal(row.session_id, "gs1");
  assert.equal(row.origin_session_id, "chat1");
  assert.equal(row.workspace_source, "origin");
  assert.equal(row.created_at, 1000);
  assert.equal(row.updated_at, 1000);
  assert.deepEqual(JSON.parse(row.budget_json), DEFAULT_BUDGET);
  assert.deepEqual(JSON.parse(row.usage_json), {
    steps: 0,
    tool_calls: 0,
    active_ms: 0,
    tokens: 0,
    model_steps: 0,
    replans: 0,
  });
  assert.equal(store.get("g1").title, "Ship report");
  assert.equal(store.get("missing"), null);

  const empty = store.create(
    goalInput({ session_id: "gs2", origin_session_id: null }),
    1001,
    "g2"
  );
  assert.equal(empty.workspace_source, "empty");
  assert.equal(empty.origin_session_id, null);
});

check("create merges budget overrides and caps text columns", () => {
  const { store } = freshStore();
  const row = store.create(
    goalInput({
      title: "t".repeat(600),
      brief: "x".repeat(20 * 1024),
      success_criteria: "y".repeat(10 * 1024),
      budget: { max_steps: 5, max_tokens: 100 },
    }),
    1000,
    "g1"
  );
  const budget = JSON.parse(row.budget_json);
  assert.equal(budget.max_steps, 5);
  assert.equal(budget.max_tokens, 100);
  assert.equal(budget.max_tool_calls, DEFAULT_BUDGET.max_tool_calls);
  assert.equal(Buffer.byteLength(row.title), 512);
  assert.equal(Buffer.byteLength(row.brief), 16 * 1024);
  assert.equal(Buffer.byteLength(row.success_criteria), 8 * 1024);
});

check("list filters by statuses, orders newest first, and clamps the limit", () => {
  const { store } = freshStore();
  store.create(goalInput({ session_id: "gs1" }), 1000, "g1");
  store.create(goalInput({ session_id: "gs2" }), 2000, "g2");
  assert.deepEqual(store.list(["planning"]).map((row) => row.id), ["g2", "g1"]);
  assert.equal(store.list(["active"]).length, 0);
  assert.equal(store.list(null).length, 2);
  assert.equal(store.list([], 1).length, 1);
});

check("one non-terminal goal per session; terminal status releases the slot", () => {
  const { store } = freshStore();
  store.create(goalInput(), 1000, "g1");
  assert.equal(store.activeGoalForSession("gs1").id, "g1");
  assert.equal(store.activeGoalForSession("other"), null);

  assert.throws(() => store.create(goalInput(), 1001, "g2"));
  assert.equal(store.get("g2"), null);

  store.update("g1", { status: "done", updated_at: 2000 });
  assert.equal(store.get("g1").status, "done");
  assert.equal(store.activeGoalForSession("gs1"), null);

  const second = store.create(goalInput(), 2001, "g2");
  assert.equal(second.status, "planning");
  assert.equal(store.activeGoalForSession("gs1").id, "g2");
});

check("update whitelists columns, merges budget and usage, and ignores injected keys", () => {
  const { store } = freshStore();
  store.create(goalInput(), 1000, "g1");
  const before = store.get("g1");
  store.update("g1", {
    budget: { max_steps: 5 },
    usage: { tokens: 10 },
    "title = 'hacked' --": 1,
    "status = 'done' --": 1,
    updated_at: 3000,
  });
  const after = store.get("g1");
  assert.equal(after.title, "Ship report");
  assert.equal(after.status, "planning");
  assert.equal(after.updated_at, 3000);
  const budget = JSON.parse(after.budget_json);
  assert.equal(budget.max_steps, 5);
  assert.equal(budget.max_tool_calls, DEFAULT_BUDGET.max_tool_calls);
  const usage = JSON.parse(after.usage_json);
  assert.equal(usage.tokens, 10);
  assert.equal(usage.steps, 0);

  store.update("g1", { summary: null, last_error: "boom" });
  assert.equal(store.get("g1").summary, null);
  assert.equal(store.get("g1").last_error, "boom");
  assert.equal(store.get("missing"), null);
  assert.ok(before.updated_at <= after.updated_at);
});

check("plans are versioned rows with capped JSON", () => {
  const { store } = freshStore();
  store.create(goalInput(), 1000, "g1");
  const plan = store.addPlan("g1", 1, { steps: [stepInput()] }, "initial", 1000);
  assert.equal(plan.goal_id, "g1");
  assert.equal(plan.version, 1);
  assert.equal(plan.reason, "initial");
  assert.deepEqual(JSON.parse(plan.plan_json).steps[0].title, "Write it");

  const big = store.addPlan("g1", 2, "x".repeat(100 * 1024), "replan", 2000);
  assert.ok(Buffer.byteLength(big.plan_json) <= 64 * 1024);
});

check("steps round-trip checks_json and wake_at, and wait_minutes is resolved", () => {
  const { store } = freshStore();
  store.create(goalInput(), 1000, "g1");
  const checks = [{ type: "file", path: "report.md", min_bytes: 1 }];
  const inserted = store.addSteps(
    "g1",
    1,
    [
      stepInput({
        kind: "wait",
        title: "Wait for window",
        wake_at: 5000,
        max_attempts: 1,
        checks: [],
      }),
      stepInput({ checks }),
    ],
    1000
  );
  assert.equal(inserted.length, 2);
  assert.equal(inserted[0].seq, 1);
  assert.equal(inserted[1].seq, 2);
  assert.equal(inserted[0].kind, "wait");
  assert.equal(inserted[0].wake_at, 5000);
  assert.equal(inserted[0].max_attempts, 1);
  assert.equal(inserted[0].status, "queued");
  assert.equal(inserted[1].attempts, 0);
  assert.deepEqual(JSON.parse(inserted[1].checks_json), checks);
  assert.equal(store.steps("g1").length, 2);

  store.addSteps(
    "g1",
    2,
    [stepInput({ kind: "wait", wake_at: undefined, wait_minutes: 10, max_attempts: 1 })],
    2000
  );
  const wait = store.steps("g1").find((row) => row.plan_version === 2);
  assert.equal(wait.wake_at, 2000 + 10 * 60_000);
});

check("claimStep claims one queued work step at a time with a lease", () => {
  const { store } = freshStore();
  store.create(goalInput(), 1000, "g1");
  const steps = store.addSteps(
    "g1",
    1,
    [
      stepInput({ kind: "wait", wake_at: 5000, max_attempts: 1 }),
      stepInput({ title: "First work" }),
      stepInput({ title: "Second work" }),
    ],
    1000
  );

  const first = store.claimStep("g1", 2000, 900_000, "tok-1");
  assert.equal(first.id, steps[1].id);
  assert.equal(first.status, "running");
  assert.equal(first.attempts, 1);
  assert.equal(first.lease_token, "tok-1");
  assert.equal(first.lease_until, 902_000);
  assert.equal(first.started_at, 2000);

  // One step per goal: the second claim returns null while the first runs.
  assert.equal(store.claimStep("g1", 2001, 900_000, "tok-2"), null);

  store.updateStep(first.id, {
    status: "done",
    lease_token: null,
    lease_until: null,
    finished_at: 2002,
    updated_at: 2002,
  });
  const second = store.claimStep("g1", 2003, 1000, "tok-2");
  assert.equal(second.id, steps[2].id);
  assert.equal(second.attempts, 1);
  assert.equal(second.lease_token, "tok-2");
  assert.equal(second.lease_until, 3003);

  // The wait step is never claimed as work.
  assert.equal(store.claimStep("g1", 2004, 1000, "tok-3"), null);
  assert.equal(store.getStep(steps[0].id).status, "queued");
});

check("claimStep returns null when only wait steps are queued", () => {
  const { store } = freshStore();
  store.create(goalInput(), 1000, "g1");
  store.addSteps(
    "g1",
    1,
    [stepInput({ kind: "wait", wake_at: 9000, max_attempts: 1 })],
    1000
  );
  assert.equal(store.claimStep("g1", 2000, 1000, "tok"), null);
});

check("updateStep caps evidence and result payloads and clears nullable fields", () => {
  const { store } = freshStore();
  store.create(goalInput(), 1000, "g1");
  const [step] = store.addSteps("g1", 1, [stepInput()], 1000);
  const updated = store.updateStep(step.id, {
    status: "verifying",
    evidence: { files: ["report.md"], hash: "abc" },
    result: "x".repeat(80 * 1024),
    last_error: "still checking",
    updated_at: 2000,
  });
  assert.equal(updated.status, "verifying");
  assert.deepEqual(JSON.parse(updated.evidence_json), {
    files: ["report.md"],
    hash: "abc",
  });
  assert.ok(Buffer.byteLength(updated.result_json) <= 32 * 1024);
  assert.equal(updated.last_error, "still checking");
  assert.equal(updated.updated_at, 2000);

  const cleared = store.updateStep(step.id, {
    evidence: null,
    result: null,
    last_error: null,
  });
  assert.equal(cleared.evidence_json, null);
  assert.equal(cleared.result_json, null);
  assert.equal(cleared.last_error, null);
});

check("runs insert idempotently, duplicate ids are ignored, and updates persist", () => {
  const { store } = freshStore();
  store.create(goalInput(), 1000, "g1");
  const run = {
    id: "run1",
    goal_id: "g1",
    step_id: "st1",
    session_id: "gs1",
    status: "running",
    usage_json: null,
    result_json: null,
    error: null,
    started_at: 100,
    finished_at: null,
  };
  store.insertRun(run);
  store.insertRun({ ...run, status: "done", finished_at: 200 });
  assert.equal(store.getRun("run1").status, "running");
  assert.equal(store.getRun("run1").finished_at, null);

  const updated = store.updateRun("run1", {
    status: "done",
    usage: {
      steps: 1,
      tool_calls: 2,
      active_ms: 5,
      tokens: 10,
      model_steps: 1,
      replans: 0,
    },
    result: { ok: true },
    finished_at: 200,
    error: null,
  });
  assert.equal(updated.status, "done");
  assert.deepEqual(JSON.parse(updated.usage_json), {
    steps: 1,
    tool_calls: 2,
    active_ms: 5,
    tokens: 10,
    model_steps: 1,
    replans: 0,
  });
  assert.deepEqual(JSON.parse(updated.result_json), { ok: true });
  assert.equal(updated.finished_at, 200);
  assert.equal(store.updateRun("missing", { status: "done" }), null);
});

check("events insert with ids and list oldest first after the id cursor", () => {
  const { store } = freshStore();
  store.create(goalInput(), 1000, "g1");
  store.create(goalInput({ session_id: "gs2", origin_session_id: null }), 1000, "g2");

  const first = store.addEvent({
    goal_id: "g1",
    type: "created",
    actor: "system",
    payload: { title: "Ship report" },
    created_at: 100,
  });
  const second = store.addEvent({
    goal_id: "g1",
    type: "planned",
    actor: "agent",
    payload_json: '{"steps":2}',
    created_at: 200,
  });
  const third = store.addEvent({
    goal_id: "g1",
    type: "step_queued",
    step_id: "st1",
    run_id: "run1",
    created_at: 300,
  });
  store.addEvent({ goal_id: "g2", type: "created", created_at: 400 });

  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
  assert.equal(third.id, 3);
  assert.deepEqual(JSON.parse(first.payload_json), { title: "Ship report" });
  assert.equal(third.actor, "system");
  assert.equal(third.step_id, "st1");
  assert.equal(third.run_id, "run1");

  assert.deepEqual(store.listEvents("g1").map((row) => row.id), [1, 2, 3]);
  assert.deepEqual(store.listEvents("g1", first.id, 10).map((row) => row.id), [2, 3]);
  assert.deepEqual(store.listEvents("g1", null, 2).map((row) => row.id), [1, 2]);

  const big = store.addEvent({
    goal_id: "g1",
    type: "verified",
    payload_json: "x".repeat(20 * 1024),
    created_at: 500,
  });
  assert.ok(Buffer.byteLength(big.payload_json) <= 16 * 1024);
});

check("attention lists unread newest first and marks read", () => {
  const { store } = freshStore();
  store.create(goalInput(), 1000, "g1");
  const first = store.addAttention({
    goal_id: "g1",
    kind: "done",
    title: "Goal done",
    body: "report.md exists",
    created_at: 100,
  });
  const second = store.addAttention({
    goal_id: "g1",
    kind: "blocked",
    title: "Needs input",
    body: "x".repeat(10 * 1024),
    created_at: 200,
  });
  assert.equal(first.read, 0);
  assert.deepEqual(store.listAttention().map((row) => row.id), [second.id, first.id]);
  assert.ok(Buffer.byteLength(second.body) <= 8 * 1024);

  const read = store.markAttentionRead(second.id);
  assert.equal(read.read, 1);
  assert.deepEqual(store.listAttention().map((row) => row.id), [first.id]);
  assert.equal(store.markAttentionRead(999), null);
  assert.equal(store.listAttention(1).length, 1);
});

check("instructions append oldest first and cap at 8 KB", () => {
  const { store } = freshStore();
  store.create(goalInput(), 1000, "g1");
  const first = store.addInstruction("g1", "Use the 2025 numbers", 100);
  const second = store.addInstruction("g1", "x".repeat(10 * 1024), 200);
  assert.deepEqual(store.instructions("g1").map((row) => row.id), [
    first.id,
    second.id,
  ]);
  assert.equal(second.content.length, 8 * 1024);
  assert.equal(store.instructions("other").length, 0);
});

check("meta upserts and clears", () => {
  const { store } = freshStore();
  assert.equal(store.meta("paused"), null);
  store.setMeta("paused", "1");
  store.setMeta("paused", "0");
  assert.equal(store.meta("paused"), "0");
  store.setMeta("paused", null);
  assert.equal(store.meta("paused"), null);
});

check("tool calls copy the ledger and cap result JSON", () => {
  const { store, sql } = freshStore();
  store.create(goalInput(), 1000, "g1");
  const call = store.addToolCall({
    goal_id: "g1",
    step_id: "st1",
    run_id: "run1",
    tool: "exec",
    input_hash: "abc",
    side_effect: true,
    result: "x".repeat(20 * 1024),
    created_at: 100,
  });
  assert.equal(call.side_effect, 1);
  assert.ok(Buffer.byteLength(call.result_json) <= 16 * 1024);
  const count = sql.exec(
    "SELECT COUNT(*) AS n FROM goal_tool_calls WHERE goal_id = ?",
    "g1"
  ).results[0].n;
  assert.equal(Number(count), 1);
});

check("pruneEvents deletes only old events for one goal, at most the limit", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = 1_800_000_000_000;
  const { store } = freshStore();
  store.create(goalInput(), now, "g1");
  store.create(goalInput({ session_id: "gs2", origin_session_id: null }), now, "g2");

  const oldOne = store.addEvent({
    goal_id: "g1",
    type: "created",
    created_at: now - 40 * day,
  });
  const oldTwo = store.addEvent({
    goal_id: "g1",
    type: "planned",
    created_at: now - 31 * day,
  });
  const live = store.addEvent({
    goal_id: "g1",
    type: "completed",
    created_at: now - day,
  });
  const other = store.addEvent({
    goal_id: "g2",
    type: "created",
    created_at: now - 40 * day,
  });

  assert.equal(store.pruneEvents("g1", now - 30 * day, 1), 1);
  let ids = store.listEvents("g1").map((row) => row.id);
  assert.deepEqual(ids, [oldTwo.id, live.id]);
  assert.equal(store.pruneEvents("g1", now - 30 * day, 10), 1);
  ids = store.listEvents("g1").map((row) => row.id);
  assert.deepEqual(ids, [live.id]);
  assert.equal(store.pruneEvents("g1", now - 30 * day, 10), 0);
  assert.deepEqual(store.listEvents("g2").map((row) => row.id), [other.id]);
  assert.ok(oldOne.id < oldTwo.id);
});

if (failures.length) {
  for (const failure of failures) console.error("  FAIL " + failure);
  process.exit(1);
}
console.log("goal store: passed");
