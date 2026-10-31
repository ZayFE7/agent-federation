// Engine behavior with a real SQLite store and fake session/fetch ports.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AutomationStore } from "../src/automation-store.ts";
import { AutomationEngine } from "../src/automation-engine.ts";

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

function makeDb() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query, ...bindings) {
      const parts = query.split("?");
      if (parts.length !== bindings.length + 1) throw new Error(`placeholder mismatch: ${query}`);
      return { results: db.prepare(parts.join("?")).all(...bindings) };
    },
  };
  const store = new AutomationStore(sql);
  store.ensureSchema();
  return store;
}

function makeEngine(store, overrides = {}) {
  let clock = 1_000_000;
  let seq = 0;
  const submits = [];
  const session = {
    exists: async (id) => id !== "missing",
    submit: async (input) => {
      submits.push(input);
      return { ok: true, streamId: `s:${input.sessionId}:op${seq}`, operationId: `op${seq++}` };
    },
    status: async () => ({ status: "done", reply: "done" }),
  };
  let body = "one";
  const fetchImpl = async () =>
    new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
  const engine = new AutomationEngine({
    store,
    sessions: session,
    fetch: fetchImpl,
    now: () => clock,
    id: () => `id${++seq}abcde`.padEnd(12, "x"),
    encrypt: async (value) => `enc:${value}`,
    decrypt: async (value) => (value.startsWith("enc:") ? value.slice(4) : ""),
    ...overrides,
  });
  return {
    engine,
    session,
    submits,
    setClock: (value) => {
      clock = value;
    },
    now: () => clock,
    setBody: (value) => {
      body = value;
    },
  };
}

function webhookInput(engine, secret, body = "{}", headers = {}) {
  return {
    automationId: "id1abcdexxx",
    mode: "generic",
    pathSecret: secret,
    bodyText: body,
    rawBody: new TextEncoder().encode(body),
    headers: { "x-event-id": `e-${Math.random()}`, ...headers },
    contentType: "application/json",
    now: Date.now(),
  };
}

const store = makeDb();
const ctx = makeEngine(store);
const created = await ctx.engine.create({
  name: "Hook",
  kind: "webhook",
  target_session_id: "s1",
  instructions: "Handle it",
  source: { type: "webhook", auth: "secret" },
});
assert.equal(created.ok, true);
assert.ok(created.secret);
const automationId = created.automation.id;

await checkAsync("wrong secret is invalid and accepted event dedupes", async () => {
  const bad = await ctx.engine.ingestHttp({
    ...webhookInput(ctx.engine, "wrong", "{}"),
    automationId,
    now: ctx.now(),
  });
  assert.equal(bad.status, "invalid");
  const first = await ctx.engine.ingestHttp({
    ...webhookInput(ctx.engine, created.secret, '{"action":"opened"}'),
    automationId,
    headers: { "x-event-id": "delivery-1" },
    now: ctx.now(),
  });
  assert.equal(first.status, "accepted");
  const duplicate = await ctx.engine.ingestHttp({
    ...webhookInput(ctx.engine, created.secret, '{"action":"opened"}'),
    automationId,
    headers: { "x-event-id": "delivery-1" },
    now: ctx.now(),
  });
  assert.equal(duplicate.status, "duplicate");
});

await checkAsync("queued event submits exactly one turn and completion closes the run", async () => {
  await ctx.engine.tick(ctx.now());
  assert.equal(ctx.submits.length, 1);
  const run = store.listRuns(automationId, 10).find((row) => row.status === "running");
  assert.ok(run, "no running run");
  await ctx.engine.completeRun({
    runId: run.id,
    automationId,
    sessionId: "s1",
    status: "done",
    reply: "handled",
  });
  assert.equal(store.getRun(run.id).status, "done");
  assert.equal(store.listEvents(automationId, 0, 10)[0].status, "done");
});

await checkAsync("condition false stores skipped and spends no turn", async () => {
  const conditional = await ctx.engine.create({
    name: "Only opened",
    kind: "webhook",
    target_session_id: "s1",
    instructions: "Handle it",
    source: { type: "webhook", auth: "secret" },
    match: { path: "action", op: "eq", value: "opened" },
  });
  const before = ctx.submits.length;
  await ctx.engine.ingestHttp({
    ...webhookInput(ctx.engine, conditional.secret, '{"action":"closed"}'),
    automationId: conditional.automation.id,
    now: ctx.now(),
  });
  await ctx.engine.tick(ctx.now());
  assert.equal(ctx.submits.length, before);
  assert.equal(store.listEvents(conditional.automation.id, 0, 10)[0].status, "skipped");
});

await checkAsync("cooldown marks the second delivery rate limited", async () => {
  const quick = await ctx.engine.create({
    name: "Quick",
    kind: "webhook",
    target_session_id: "s1",
    instructions: "Handle it",
    source: { type: "webhook", auth: "secret" },
  });
  const one = await ctx.engine.ingestHttp({
    ...webhookInput(ctx.engine, quick.secret, "{}"),
    automationId: quick.automation.id,
    headers: { "x-event-id": "q1" },
    now: ctx.now(),
  });
  assert.equal(one.status, "accepted");
  const two = await ctx.engine.ingestHttp({
    ...webhookInput(ctx.engine, quick.secret, "{}"),
    automationId: quick.automation.id,
    headers: { "x-event-id": "q2" },
    now: ctx.now(),
  });
  assert.equal(two.status, "rate_limited");
});

await checkAsync("a watcher seeds, then fires only on change", async () => {
  const watcher = await ctx.engine.create({
    name: "Watch",
    kind: "watch",
    target_session_id: "s1",
    instructions: "Report changes",
    source: { type: "watch", url: "https://example.com/page", interval_minutes: 5 },
  });
  assert.equal(watcher.ok, true);
  store.update(watcher.automation.id, { next_run_at: ctx.now() });
  await ctx.engine.tick(ctx.now());
  assert.equal(store.listEvents(watcher.automation.id, 0, 10).length, 0);
  ctx.setBody("two");
  store.update(watcher.automation.id, { next_run_at: ctx.now() });
  await ctx.engine.tick(ctx.now());
  assert.equal(store.listEvents(watcher.automation.id, 0, 10).length, 1);
});

await checkAsync("a due schedule queues its event and advances next_run_at", async () => {
  const schedule = await ctx.engine.create({
    name: "Every five",
    kind: "schedule",
    target_session_id: "s1",
    instructions: "Say hello",
    source: { type: "schedule", every_minutes: 5 },
  });
  store.update(schedule.automation.id, { next_run_at: ctx.now() });
  await ctx.engine.tick(ctx.now());
  const row = store.get(schedule.automation.id);
  assert.ok(row.next_run_at > ctx.now());
  assert.equal(store.listEvents(schedule.automation.id, 0, 10).length, 1);
});

await check("create rejects a missing target before writing", async () => {
  const result = await ctx.engine.create({
    name: "Nope",
    kind: "webhook",
    target_session_id: "missing",
    instructions: "x",
    source: { type: "webhook", auth: "secret" },
  });
  assert.equal(result.ok, false);
});

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log("automation engine: passed");
