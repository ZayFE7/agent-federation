// Session-side goal run store: one active run per session, operation mapping,
// and the write-ahead tool ledger.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  clearGoalRun,
  ensureGoalRunSchema,
  finishGoalTool,
  getActiveGoalRun,
  intentGoalTool,
  listGoalOperations,
  listGoalTools,
  startGoalRun,
  upsertGoalOperation,
} from "../src/goal-run-store.ts";

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

const db = new DatabaseSync(":memory:");
const sql = {
  exec(query, ...bindings) {
    const parts = query.split("?");
    if (parts.length !== bindings.length + 1) throw new Error("placeholder mismatch");
    return { results: db.prepare(parts.join("?")).all(...bindings) };
  },
};
ensureGoalRunSchema(sql);

const run = {
  run_id: "run1",
  goal_id: "g1",
  step_id: "s1",
  session_id: "sess1",
  lease_token: "lease1",
  prompt: "do it",
  checks_json: "[{\"type\":\"file\",\"path\":\"x\"}]",
  status: "running",
  created_at: 1,
  updated_at: 1,
};

check("one active run per session", () => {
  assert.equal(startGoalRun(sql, run), true);
  assert.equal(startGoalRun(sql, { ...run, run_id: "run2" }), false);
  assert.equal(getActiveGoalRun(sql, "sess1").run_id, "run1");
});

check("operation mapping is idempotent", () => {
  upsertGoalOperation(sql, {
    run_id: "run1",
    operation_id: "op1",
    root: 1,
    status: "running",
    usage_json: null,
    created_at: 2,
    updated_at: 2,
  });
  upsertGoalOperation(sql, {
    run_id: "run1",
    operation_id: "op1",
    root: 1,
    status: "done",
    usage_json: '{"tokens":5}',
    created_at: 2,
    updated_at: 3,
  });
  const ops = listGoalOperations(sql, "run1");
  assert.equal(ops.length, 1);
  assert.equal(ops[0].status, "done");
  assert.equal(ops[0].usage_json, '{"tokens":5}');
});

check("intent is visible before finish and finish updates the same row", () => {
  const id = intentGoalTool(sql, {
    run_id: "run1",
    goal_id: "g1",
    step_id: "s1",
    tool: "exec",
    input_hash: "hash",
    side_effect: 1,
    result_json: null,
  });
  assert.ok(id > 0);
  let rows = listGoalTools(sql, "run1");
  assert.equal(rows[0].status, "intent");
  finishGoalTool(sql, id, "finished", "ok");
  rows = listGoalTools(sql, "run1");
  assert.equal(rows[0].status, "finished");
  assert.equal(rows[0].result_json, "ok");
});

check("clear removes only the active run, preserving audit", () => {
  clearGoalRun(sql, "run1");
  assert.equal(getActiveGoalRun(sql, "sess1"), null);
  assert.equal(listGoalTools(sql, "run1").length, 1);
  assert.equal(listGoalOperations(sql, "run1").length, 1);
});

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log("goal run store: passed");
