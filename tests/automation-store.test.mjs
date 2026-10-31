// Automation store over real node:sqlite through the same SqlHandle adapter as
// tests/artifacts.test.mjs. Covers dedupe, caps, rate windows, and pruning.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AutomationStore } from "../src/automation-store.ts";

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
  const store = new AutomationStore(sql);
  store.ensureSchema();
  return { store, sql, db };
}

const A = "aaaa0001";
const B = "bbbb0002";
const C = "cccc0003";

function input(over = {}) {
  return {
    name: "Hook",
    kind: "webhook",
    target_session_id: "main",
    instructions: "Do the thing",
    source: { type: "webhook", auth: "secret" },
    ...over,
  };
}

function eventRow(automationId, id, key, createdAt, over = {}) {
  return {
    id,
    automation_id: automationId,
    event_key: key,
    source: "webhook",
    event_type: "push",
    payload_json: "{}",
    headers_json: null,
    status: "received",
    reason: null,
    run_id: null,
    created_at: createdAt,
    updated_at: createdAt,
    ...over,
  };
}

function runRow(automationId, id, createdAt, over = {}) {
  return {
    id,
    automation_id: automationId,
    event_id: "ev",
    session_id: "main",
    stream_id: null,
    operation_id: null,
    status: "submitting",
    reply: null,
    error: null,
    attempts: 0,
    started_at: null,
    finished_at: null,
    created_at: createdAt,
    ...over,
  };
}

check("schema is idempotent and meta upserts", () => {
  const { store } = freshStore();
  store.ensureSchema();
  assert.equal(store.meta("schema_version"), null);
  assert.equal(store.hasMeta("schema_version"), false);
  store.setMeta("schema_version", "1");
  store.setMeta("schema_version", "2");
  assert.equal(store.meta("schema_version"), "2");
  assert.equal(store.hasMeta("schema_version"), true);
});

check("create fills defaults and list filters by status and kind", () => {
  const { store } = freshStore();
  const row = store.create(input(), 1000, A);
  assert.equal(row.cooldown_ms, 10000);
  assert.equal(row.max_per_hour, 20);
  assert.equal(row.enabled, 1);
  assert.equal(row.next_run_at, null);
  assert.equal(row.secret_enc, null);
  assert.equal(row.consecutive_failures, 0);
  assert.equal(row.created_at, 1000);
  assert.equal(store.get(A).name, "Hook");
  assert.equal(store.get("nope"), null);

  store.create(input({ kind: "schedule", name: "Daily", source: { type: "schedule", daily_at: "09:00" } }), 1001, B);
  store.setEnabled(B, false);
  assert.deepEqual(store.list({ status: "active" }).map((item) => item.id), [A]);
  assert.deepEqual(store.list({ kind: "schedule" }).map((item) => item.id), [B]);
  assert.equal(store.list({}, 1).length, 1);
  assert.equal(store.list().length, 2);
});

check("create caps instructions at 8 KB", () => {
  const { store } = freshStore();
  const row = store.create(input({ instructions: "x".repeat(9000) }), 1000, A);
  assert.equal(Buffer.byteLength(row.instructions), 8 * 1024);
});

check("update touches only provided fields and ignores injected keys", () => {
  const { store } = freshStore();
  store.create(input(), 1000, A);
  const before = store.get(A);
  store.update(A, {
    name: "Renamed",
    cooldown_ms: 5000,
    next_run_at: 99,
    "kind = 'watch' --": 1,
    "name = 'hacked'": 2,
  });
  const after = store.get(A);
  assert.equal(after.name, "Renamed");
  assert.equal(after.cooldown_ms, 5000);
  assert.equal(after.max_per_hour, 20);
  assert.equal(after.kind, "webhook");
  assert.equal(after.next_run_at, 99);
  assert.ok(after.updated_at > before.updated_at);

  store.update(A, { next_run_at: null, last_error: null });
  assert.equal(store.get(A).next_run_at, null);
});

check("rotateSecret stores the ciphertext, hint, and clock", () => {
  const { store } = freshStore();
  store.create(input(), 1000, A);
  store.rotateSecret(A, "encrypted-value", "wxyz", 2500);
  const row = store.get(A);
  assert.equal(row.secret_enc, "encrypted-value");
  assert.equal(row.secret_hint, "wxyz");
  assert.equal(row.updated_at, 2500);
});

check("a duplicate (automation_id, event_key) never inserts or overwrites", () => {
  const { store } = freshStore();
  store.create(input(), 1000, A);
  store.create(input({ kind: "schedule", source: { type: "schedule", daily_at: "01:00" } }), 1001, B);

  const first = eventRow(A, "ev1", "delivery-1", 100);
  assert.equal(store.insertEvent(first), true);
  const duplicate = eventRow(A, "ev2", "delivery-1", 200, { status: "done" });
  assert.equal(store.insertEvent(duplicate), false);
  assert.equal(store.getEventByKey(A, "delivery-1").id, "ev1");
  assert.equal(store.getEventByKey(A, "delivery-1").status, "received");

  // The unique index is per automation, not global.
  assert.equal(store.insertEvent(eventRow(B, "ev3", "delivery-1", 200)), true);
  assert.equal(store.listEvents(A, null, 10).length, 1);
});

check("event payload and headers are capped before storage", () => {
  const { store } = freshStore();
  store.create(input(), 1000, A);
  const big = "x".repeat(40 * 1024);
  assert.equal(
    store.insertEvent(
      eventRow(A, "evbig", "big", 100, {
        payload_json: big,
        headers_json: JSON.stringify({ "x-big": big }),
      })
    ),
    true
  );
  const row = store.getEventByKey(A, "big");
  assert.ok(Buffer.byteLength(row.payload_json) <= 32 * 1024);
  assert.ok(Buffer.byteLength(row.headers_json) <= 8 * 1024);
});

check("events can be updated and listed newest first after a cursor", () => {
  const { store } = freshStore();
  store.create(input(), 1000, C);
  store.insertEvent(eventRow(C, "e1", "k1", 100));
  store.insertEvent(eventRow(C, "e2", "k2", 200));
  store.insertEvent(eventRow(C, "e3", "k3", 300));

  assert.deepEqual(store.listEvents(C, null, 10).map((row) => row.id), ["e3", "e2", "e1"]);
  assert.deepEqual(store.listEvents(C, 100, 10).map((row) => row.id), ["e3", "e2"]);
  assert.deepEqual(store.listEvents(C, null, 2).map((row) => row.id), ["e3", "e2"]);

  const updated = store.updateEvent("e2", {
    status: "done",
    reason: "finished",
    run_id: "run9",
    attempts: 2,
  });
  assert.equal(updated.status, "done");
  assert.equal(updated.reason, "finished");
  assert.equal(updated.run_id, "run9");
  assert.equal(updated.attempts, 2);
  assert.ok(updated.updated_at > updated.created_at);
});

check("runs insert idempotently, update, and list newest first", () => {
  const { store } = freshStore();
  store.create(input(), 1000, A);
  store.insertRun(runRow(A, "run1", 100));
  store.insertRun(runRow(A, "run1", 100));
  store.insertRun(runRow(A, "run2", 200, { status: "running" }));
  assert.equal(store.listRuns(A, 10).length, 2);

  const updated = store.updateRun("run1", {
    status: "running",
    stream_id: "stream-1",
    operation_id: "op-1",
    attempts: 1,
    started_at: 150,
  });
  assert.equal(updated.status, "running");
  assert.equal(updated.stream_id, "stream-1");
  assert.equal(updated.attempts, 1);
  assert.equal(store.getRun("run1").started_at, 150);
  assert.deepEqual(store.listRuns(A, 10).map((row) => row.id), ["run2", "run1"]);
  assert.equal(store.getRun("missing"), null);
});

check("watch state upserts one row per automation", () => {
  const { store } = freshStore();
  store.upsertWatchState({
    automation_id: A,
    fingerprint: "f1",
    last_value: "v1",
    last_checked_at: 100,
    last_status: 200,
    consecutive_errors: 0,
  });
  store.upsertWatchState({
    automation_id: A,
    fingerprint: "f2",
    last_value: "v2",
    last_checked_at: 200,
    last_status: 500,
    consecutive_errors: 3,
  });
  const state = store.watchState(A);
  assert.equal(state.fingerprint, "f2");
  assert.equal(state.last_value, "v2");
  assert.equal(state.last_status, 500);
  assert.equal(state.consecutive_errors, 3);
  assert.equal(store.watchState("missing"), null);
});

check("rate windows count and bump independently", () => {
  const { store } = freshStore();
  const window = 3_600_000;
  assert.equal(store.rateCount(A, window), 0);
  assert.equal(store.bumpRate(A, window), 1);
  assert.equal(store.bumpRate(A, window), 2);
  assert.equal(store.rateCount(A, window), 2);
  assert.equal(store.rateCount(A, window + 3_600_000), 0);
  assert.equal(store.rateCount(B, window), 0);
});

check("prune removes old events, runs, and rate windows but keeps automations", () => {
  const now = 1_800_000_000_000;
  const day = 24 * 60 * 60 * 1000;
  const { store } = freshStore();
  store.create(input(), now, A);
  store.insertEvent(eventRow(A, "old-ev", "old", now - 31 * day));
  store.insertEvent(eventRow(A, "new-ev", "new", now - day));
  store.insertRun(runRow(A, "old-run", now - 31 * day));
  store.insertRun(runRow(A, "new-run", now - day, { status: "done" }));
  store.bumpRate(A, now - 25 * 60 * 60 * 1000);
  store.bumpRate(A, now - 60 * 60 * 1000);

  store.prune(now);

  assert.equal(store.getEventByKey(A, "old"), null);
  assert.ok(store.getEventByKey(A, "new"));
  assert.equal(store.getRun("old-run"), null);
  assert.ok(store.getRun("new-run"));
  assert.equal(store.rateCount(A, now - 25 * 60 * 60 * 1000), 0);
  assert.equal(store.rateCount(A, now - 60 * 60 * 1000), 1);
  assert.ok(store.get(A));
});

check("prune caps events per automation at 5,000 without touching the rest", () => {
  const now = 1_800_000_000_000;
  const total = 5003;
  const { store, sql } = freshStore();
  store.create(input(), now, A);
  for (let index = 0; index < total; index += 1) {
    store.insertEvent(
      eventRow(A, `ev-${index}`, `k-${index}`, now - (total - index) * 1000)
    );
  }
  store.prune(now);
  const count = sql.exec(
    "SELECT COUNT(*) AS n FROM automation_events WHERE automation_id = ?",
    A
  ).results[0].n;
  assert.equal(Number(count), 5000);
  assert.equal(store.getEventByKey(A, "k-0"), null);
  assert.equal(store.getEventByKey(A, "k-1"), null);
  assert.equal(store.getEventByKey(A, "k-2"), null);
  assert.ok(store.getEventByKey(A, `k-${total - 1}`));
  assert.ok(store.get(A));
});

if (failures.length) {
  for (const failure of failures) console.error("  FAIL " + failure);
  process.exit(1);
}
console.log("automation store: passed");
