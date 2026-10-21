// Contract tests for src/workspace-store.ts, the pointer row that says which KV
// archive holds a session's current workspace (plan Task 29; Task 30 reads it).
//
// Two layers, same as tests/registry-store.test.mjs. The fake pins WHICH statement
// each function emits and HOW it binds (a fake that invents `meta.changes` would
// test an interface production cannot supply, R37). Then a real node:sqlite
// database runs the same statements, which is the only way to prove the interesting
// behaviour here: a too-large attempt has to leave the last good pointer intact,
// and a snapshot that lands has to clear the stale over-limit warning.
//
// Plain Node, no framework: `node tests/workspace-store.test.mjs`. Silent on
// success (exit 0). Prints every failure and exits 1 otherwise.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { fakeSql } from "./fake-sql.mjs";
import {
  clearWorkspace,
  ensureWorkspaceSchema,
  getWorkspace,
  recordSnapshot,
  recordTooLarge,
} from "../src/workspace-store.ts";

const COLS = "session_id, key, bytes, files, sha256, updated_at, over_limit_bytes";

const GOOD = Object.freeze({
  session_id: "s7",
  key: "ws:tar:s7",
  bytes: 2170,
  files: 4,
  sha256: "aa56".padEnd(64, "0"),
  updated_at: 5_000,
  over_limit_bytes: null,
});

const failures = [];
const fakes = [];

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

function newFake() {
  const sql = fakeSql();
  fakes.push(sql);
  return sql;
}

const flat = (q) => q.replace(/\s+/g, " ").trim();

function onlyStmt(sql) {
  assert.equal(sql.stmts.length, 1, `expected one statement, got ${sql.stmts.length}`);
  return [flat(sql.stmts[0][0]), sql.stmts[0][1]];
}

// ---- statement shape, against the fake ----

check("ensureWorkspaceSchema declares every column the row type carries", () => {
  const sql = newFake();
  assert.equal(ensureWorkspaceSchema(sql), undefined);
  assert.equal(sql.stmts.length, 1, "exactly one CREATE TABLE");
  const [ddl, bindings] = onlyStmt(sql);
  assert.match(ddl, /^CREATE TABLE IF NOT EXISTS workspace_state\b/, ddl);
  for (const fragment of [
    "session_id TEXT PRIMARY KEY",
    "key TEXT NOT NULL",
    "bytes INTEGER NOT NULL",
    "files INTEGER NOT NULL",
    "sha256 TEXT NOT NULL",
    "updated_at INTEGER NOT NULL",
    "over_limit_bytes INTEGER",
  ]) {
    assert.ok(ddl.includes(fragment), `ddl missing ${fragment}: ${ddl}`);
  }
  assert.deepEqual(bindings, [], "schema DDL binds nothing");
});

check("ensureWorkspaceSchema is idempotent as text, so a repeated onStart cannot fail", () => {
  const sql = newFake();
  ensureWorkspaceSchema(sql);
  ensureWorkspaceSchema(sql);
  assert.deepEqual(sql.stmts.slice(0, 1), sql.stmts.slice(1));
});

check("getWorkspace selects the row columns by session id and answers null when absent", () => {
  const sql = newFake();
  assert.equal(getWorkspace(sql, "s7"), null);
  const [query, bindings] = onlyStmt(sql);
  assert.equal(query, `SELECT ${COLS} FROM workspace_state WHERE session_id = ?`);
  assert.deepEqual(bindings, ["s7"]);
});

check("getWorkspace returns the row it read", () => {
  const sql = newFake();
  sql.query("FROM workspace_state", [GOOD]);
  assert.deepEqual(getWorkspace(sql, "s7"), GOOD);
});

check("recordSnapshot replaces the row and clears the over-limit warning", () => {
  const sql = newFake();
  // A caller that passes a stale warning still cannot leave it on a good pointer.
  recordSnapshot(sql, { ...GOOD, over_limit_bytes: 99_000 });
  const [query, bindings] = onlyStmt(sql);
  assert.equal(
    query,
    `INSERT OR REPLACE INTO workspace_state (${COLS}) VALUES (?, ?, ?, ?, ?, ?, NULL)`
  );
  assert.deepEqual(bindings, ["s7", "ws:tar:s7", 2170, 4, GOOD.sha256, 5_000]);
});

check("recordTooLarge updates the warning only when a pointer already exists", () => {
  const sql = newFake();
  sql.query("FROM workspace_state", [GOOD]);
  recordTooLarge(sql, "s7", 40_000_000, 9_000);
  const [select, writes] = [sql.stmts[0], sql.stmts.slice(1)];
  assert.match(flat(select[0]), /^SELECT /, "must read first: there is no changes count (R37)");
  assert.equal(writes.length, 1, `expected one write, got ${writes.length}`);
  const [query, bindings] = [flat(writes[0][0]), writes[0][1]];
  assert.equal(query, "UPDATE workspace_state SET over_limit_bytes = ? WHERE session_id = ?");
  assert.deepEqual(bindings, [40_000_000, "s7"]);
});

check("recordTooLarge starts a pointer when there is nothing to preserve", () => {
  const sql = newFake();
  recordTooLarge(sql, "s7", 40_000_000, 9_000);
  assert.equal(sql.stmts.length, 2, "one read then one write");
  const [query, bindings] = [flat(sql.stmts[1][0]), sql.stmts[1][1]];
  assert.equal(
    query,
    `INSERT OR REPLACE INTO workspace_state (${COLS}) VALUES (?, '', 0, 0, '', ?, ?)`
  );
  assert.deepEqual(bindings, ["s7", 9_000, 40_000_000]);
});

check("clearWorkspace deletes by session id", () => {
  const sql = newFake();
  clearWorkspace(sql, "s7");
  const [query, bindings] = onlyStmt(sql);
  assert.equal(query, "DELETE FROM workspace_state WHERE session_id = ?");
  assert.deepEqual(bindings, ["s7"]);
});

// Every recorded statement of every function, checked for one placeholder per
// binding, which is what src/sql-handle.ts enforces in production.
check("no statement mismatches its placeholders and bindings", () => {
  for (const sql of fakes) {
    for (const [query, bindings] of sql.stmts) {
      assert.equal(
        query.split("?").length - 1,
        bindings.length,
        `placeholder mismatch (${query.split("?").length - 1} vs ${bindings.length}): ${flat(query)}`
      );
    }
  }
});

// ---- real execution: the same statements against sqlite ----

const db = new DatabaseSync(":memory:");
const real = {
  exec(query, ...bindings) {
    const parts = query.split("?");
    if (parts.length !== bindings.length + 1) {
      throw new Error(`placeholder mismatch: ${parts.length - 1} vs ${bindings.length}`);
    }
    return { results: db.prepare(parts.join("?")).all(...bindings) };
  },
};

// node:sqlite hands back null-prototype rows; strict deepEqual reads that as a
// different shape than an object literal.
const plain = (row) => ({ ...row });

check("the schema statements execute, twice", () => {
  ensureWorkspaceSchema(real);
  ensureWorkspaceSchema(real);
});

check("a recorded snapshot reads back with every field intact", () => {
  recordSnapshot(real, GOOD);
  assert.deepEqual(plain(getWorkspace(real, "s7")), GOOD);
});

check("a too-large attempt keeps the last good pointer and adds only the warning", () => {
  recordTooLarge(real, "s7", 40_000_000, 9_000);
  assert.deepEqual(plain(getWorkspace(real, "s7")), { ...GOOD, over_limit_bytes: 40_000_000 });
});

check("a snapshot that lands clears the stale warning", () => {
  const later = { ...GOOD, bytes: 3_000, files: 5, updated_at: 20_000 };
  recordSnapshot(real, { ...later, over_limit_bytes: 40_000_000 });
  assert.deepEqual(plain(getWorkspace(real, "s7")), later);
});

check("sessions do not share a pointer row", () => {
  recordSnapshot(real, { ...GOOD, session_id: "s8", key: "ws:tar:s8", sha256: "bb".padEnd(64, "1") });
  recordTooLarge(real, "s7", 50_000_000, 30_000);
  const s8 = plain(getWorkspace(real, "s8"));
  assert.equal(s8.over_limit_bytes, null, "another session's overrun leaked onto this pointer");
  assert.equal(s8.key, "ws:tar:s8");
});

check("a too-large attempt with no history stores an empty pointer, not a lie", () => {
  recordTooLarge(real, "fresh", 60_000_000, 7_000);
  assert.deepEqual(plain(getWorkspace(real, "fresh")), {
    session_id: "fresh",
    key: "",
    bytes: 0,
    files: 0,
    sha256: "",
    updated_at: 7_000,
    over_limit_bytes: 60_000_000,
  });
});

check("clearWorkspace removes one session and nothing else", () => {
  clearWorkspace(real, "fresh");
  assert.equal(getWorkspace(real, "fresh"), null);
  assert.notEqual(getWorkspace(real, "s7"), null);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM workspace_state WHERE session_id = 'fresh'").all()[0].n,
    0
  );
});

check("an injection-shaped session id is stored as data, not run", () => {
  const nasty = "x'; DROP TABLE workspace_state; --";
  recordSnapshot(real, { ...GOOD, session_id: nasty, key: "ws:tar:x" });
  assert.equal(getWorkspace(real, nasty).key, "ws:tar:x");
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE name = 'workspace_state'").all().length,
    1
  );
});

if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL ${f}`);
  process.exit(1);
}
