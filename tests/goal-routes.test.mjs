// Contract tests for the authenticated /api/goals family. The coordinator is
// reached through the AUTONOMY binding; these tests pin auth, argument
// validation, and the exact RPC each route makes. Plain Node.

import assert from "node:assert/strict";
import { handleGoals } from "../src/goal-routes.ts";

const failures = [];
let checks = 0;

function check(name, fn) {
  checks++;
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

async function checkAsync(name, fn) {
  checks++;
  try {
    await fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

function coordinator(overrides = {}) {
  const calls = [];
  const stub = {
    calls,
    async listGoals(statuses, limit) {
      calls.push(["listGoals", statuses, limit]);
      return [{ id: "goal0001", title: "One", status: "active" }];
    },
    async globalPaused() {
      calls.push(["globalPaused"]);
      return true;
    },
    async createGoal(input) {
      calls.push(["createGoal", input]);
      return overrides.createResult ?? {
        ok: true,
        goal: { id: "goal0001", title: input.title, session_id: "session1" },
      };
    },
    async getGoal(id) {
      calls.push(["getGoal", id]);
      return id === "goal0001" ? { id, title: "One" } : null;
    },
    async goalEvents(id, after, limit) {
      calls.push(["goalEvents", id, after, limit]);
      return [{ id: 1, type: "created" }];
    },
    async controlGoal(id, action, note) {
      calls.push(["controlGoal", id, action, note]);
      return { ok: true };
    },
    async goalAttention(limit) {
      calls.push(["goalAttention", limit]);
      return [{ id: 1, kind: "done" }];
    },
    async readGoalAttention(id) {
      calls.push(["readGoalAttention", id]);
      return id === 1;
    },
    async setGlobalPause(paused) {
      calls.push(["setGlobalPause", paused]);
    },
  };
  return stub;
}

function env(stub) {
  return {
    AGENT_API_KEY: "k",
    AUTONOMY: {
      idFromName(name) {
        return { __name: name, toString: () => `autonomy:${name}` };
      },
      get() {
        return stub;
      },
    },
  };
}

function request(path, init = {}, key = "k") {
  return new Request(`https://blip.test${path}`, {
    ...init,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}

await checkAsync("every goal route requires the bearer key", async () => {
  const stub = coordinator();
  const res = await handleGoals(request("/api/goals", {}, ""), env(stub));
  assert.equal(res.status, 401);
  assert.equal(stub.calls.length, 0);
});

await checkAsync("a non-goal path is not claimed", async () => {
  const res = await handleGoals(request("/api/sessions"), env(coordinator()));
  assert.equal(res, null);
});

await checkAsync("GET /api/goals lists with parsed filters and the pause flag", async () => {
  const stub = coordinator();
  const res = await handleGoals(
    request("/api/goals?status=active,blocked&limit=7"),
    env(stub)
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(stub.calls, [["listGoals", ["active", "blocked"], 7], ["globalPaused"]]);
  assert.equal(body.paused, true);
  assert.equal(body.goals.length, 1);
});

await checkAsync("POST /api/goals refuses missing fields", async () => {
  const stub = coordinator();
  const res = await handleGoals(
    request("/api/goals", {
      method: "POST",
      body: JSON.stringify({ title: "Only a title" }),
      headers: { "content-type": "application/json" },
    }),
    env(stub)
  );
  assert.equal(res.status, 400);
  assert.equal(stub.calls.length, 0);
});

await checkAsync("POST /api/goals creates with origin and budget", async () => {
  const stub = coordinator();
  const res = await handleGoals(
    request("/api/goals", {
      method: "POST",
      body: JSON.stringify({
        title: " Clean inbox ",
        brief: " Sort it ",
        success_criteria: " Zero promos ",
        origin_session_id: "abc",
        budget: { max_steps: 4 },
      }),
      headers: { "content-type": "application/json" },
    }),
    env(stub)
  );
  assert.equal(res.status, 201);
  assert.deepEqual(stub.calls[0], [
    "createGoal",
    {
      title: "Clean inbox",
      brief: "Sort it",
      success_criteria: "Zero promos",
      origin_session_id: "abc",
      budget: { max_steps: 4 },
    },
  ]);
});

await checkAsync("a refused create answers 409", async () => {
  const stub = coordinator({ createResult: { ok: false, error: "nope" } });
  const res = await handleGoals(
    request("/api/goals", {
      method: "POST",
      body: JSON.stringify({
        title: "T",
        brief: "B",
        success_criteria: "C",
      }),
      headers: { "content-type": "application/json" },
    }),
    env(stub)
  );
  assert.equal(res.status, 409);
});

await checkAsync("GET detail 404s for an unknown goal and 400s for a bad id", async () => {
  const stub = coordinator();
  const missing = await handleGoals(request("/api/goals/goal9999"), env(stub));
  assert.equal(missing.status, 404);
  const bad = await handleGoals(request("/api/goals/Not-A-Goal!"), env(stub));
  assert.equal(bad.status, 400);
});

await checkAsync("GET events clamps and passes the cursor", async () => {
  const stub = coordinator();
  const res = await handleGoals(
    request("/api/goals/goal0001/events?after=4&limit=9999"),
    env(stub)
  );
  assert.equal(res.status, 200);
  assert.deepEqual(stub.calls, [["goalEvents", "goal0001", 4, 500]]);
});

await checkAsync("POST control validates the action and forwards it", async () => {
  const stub = coordinator();
  const bad = await handleGoals(
    request("/api/goals/goal0001/control", {
      method: "POST",
      body: JSON.stringify({ action: "delete" }),
      headers: { "content-type": "application/json" },
    }),
    env(stub)
  );
  assert.equal(bad.status, 400);
  const ok = await handleGoals(
    request("/api/goals/goal0001/control", {
      method: "POST",
      body: JSON.stringify({ action: "instruct", note: "  focus on spam  " }),
      headers: { "content-type": "application/json" },
    }),
    env(stub)
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(stub.calls, [
    ["controlGoal", "goal0001", "instruct", "  focus on spam  "],
  ]);
});

await checkAsync("budget control serializes the object as the note", async () => {
  const stub = coordinator();
  await handleGoals(
    request("/api/goals/goal0001/control", {
      method: "POST",
      body: JSON.stringify({ action: "budget", budget: { max_steps: 9 } }),
      headers: { "content-type": "application/json" },
    }),
    env(stub)
  );
  assert.deepEqual(stub.calls, [
    ["controlGoal", "goal0001", "budget", JSON.stringify({ max_steps: 9 })],
  ]);
});

await checkAsync("pause-all and resume-all reach the coordinator", async () => {
  const stub = coordinator();
  const paused = await handleGoals(
    request("/api/goals/pause-all", { method: "POST" }),
    env(stub)
  );
  const resumed = await handleGoals(
    request("/api/goals/resume-all", { method: "POST" }),
    env(stub)
  );
  assert.equal(paused.status, 200);
  assert.equal(resumed.status, 200);
  assert.deepEqual(stub.calls, [["setGlobalPause", true], ["setGlobalPause", false]]);
});

await checkAsync("attention is read-only", async () => {
  const stub = coordinator();
  const res = await handleGoals(request("/api/goals/attention"), env(stub));
  assert.equal(res.status, 200);
  const denied = await handleGoals(
    request("/api/goals/attention", { method: "POST" }),
    env(stub)
  );
  assert.equal(denied.status, 405);
  assert.deepEqual(stub.calls, [["goalAttention", 50]]);
});

await checkAsync("an attention row is marked read by its numeric id", async () => {
  const stub = coordinator();
  const ok = await handleGoals(
    request("/api/goals/attention/1/read", { method: "POST" }),
    env(stub)
  );
  assert.equal(ok.status, 200);
  const missing = await handleGoals(
    request("/api/goals/attention/2/read", { method: "POST" }),
    env(stub)
  );
  assert.equal(missing.status, 404);
  const bad = await handleGoals(
    request("/api/goals/attention/abc/read", { method: "POST" }),
    env(stub)
  );
  assert.equal(bad.status, 400);
  assert.deepEqual(stub.calls, [
    ["readGoalAttention", 1],
    ["readGoalAttention", 2],
  ]);
});

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`goal-routes: ${failures.length} of ${checks} failed`);
  process.exit(1);
}
console.log("goal-routes: passed");
