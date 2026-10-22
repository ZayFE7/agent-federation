// Contract tests for src/registry-store.ts, the pure session index that Task 6 wraps
// in a Durable Object and Task 7 exposes over HTTP.
// Plain Node, no framework, no build step: run with `node tests/registry-store.test.mjs`.
// Node 22.6+/24 strips the .ts types on import, so this needs nothing else.
//
// Two layers on purpose. tests/fake-sql.mjs pins WHICH statement each function emits
// and HOW it binds its values; the production adapter (src/sql-handle.ts, which both
// DOs call from `db()`) splits each query on "?" and refuses a mismatch, so every
// recorded statement is checked for exactly one placeholder per binding as well. A real
// node:sqlite database then runs the same statements, which a fixture that only matches
// text cannot prove.
//
// Silent on success (exit 0). Prints every failure and exits 1 otherwise.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { fakeSql } from "./fake-sql.mjs";
import {
  PLACEHOLDER_TITLE,
  ensureRegistrySchema,
  upsertSession,
  listSessions,
  getSession,
  readRegistryMeta,
  renameSession,
  touchSession,
  deleteSession,
  writeRegistryMeta,
} from "../src/registry-store.ts";

const COLUMNS = "id, title, created_at, updated_at, workspace_ref, unread, pinned";
const INJECTION_TITLE = "x'; DROP TABLE sessions; --";
const INJECTED = { id: "inj", title: INJECTION_TITLE, created_at: 1, updated_at: 1, workspace_ref: "ws", unread: 1, pinned: 1 };

const ROW = Object.freeze({
  id: "abc123",
  title: "Drafts",
  created_at: 1000,
  updated_at: 2000,
  workspace_ref: null,
  unread: 0,
  pinned: 0,
});

const failures = [];
const fakes = [];

function record(name, err) {
  failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
}

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    record(name, err);
  }
}

// Retained so the two sweeps at the end see every statement the store emitted, not
// just the ones a single check happened to assert on.
function newFake() {
  const sql = fakeSql();
  fakes.push(sql);
  return sql;
}

// Whitespace-normalized so a multi-line template literal in src/ reads as one line.
const flat = (query) => query.replace(/\s+/g, " ").trim();

// The store's one statement for its nth call, as [text, bindings].
function onlyStmt(sql) {
  assert.equal(sql.stmts.length, 1, `expected one statement, got ${sql.stmts.length}`);
  return [flat(sql.stmts[0][0]), sql.stmts[0][1]];
}

check("PLACEHOLDER_TITLE is the exact string Task 6 seeds and Task 9 compares against", () => {
  assert.equal(PLACEHOLDER_TITLE, "New session");
});

check("ensureRegistrySchema creates sessions with every SessionRow column declared", () => {
  const sql = newFake();
  assert.equal(ensureRegistrySchema(sql), undefined);
  assert.equal(sql.stmts.length, 3, "two CREATE TABLE plus one CREATE INDEX");
  const ddl = flat(sql.stmts[0][0]);
  assert.match(ddl, /^CREATE TABLE IF NOT EXISTS sessions\b/, ddl);
  for (const fragment of [
    "id TEXT PRIMARY KEY",
    "title TEXT NOT NULL",
    "created_at INTEGER NOT NULL",
    "updated_at INTEGER NOT NULL",
    "workspace_ref TEXT",
    "unread INTEGER NOT NULL DEFAULT 0",
    "pinned INTEGER NOT NULL DEFAULT 0",
  ]) {
    assert.ok(ddl.includes(fragment), `ddl missing ${fragment}: ${ddl}`);
  }
  assert.deepEqual(sql.stmts[0][1], [], "schema DDL binds nothing");
});

check("ensureRegistrySchema creates registry_meta as a key/value table", () => {
  const sql = newFake();
  ensureRegistrySchema(sql);
  const ddl = flat(sql.stmts[1][0]);
  assert.match(ddl, /^CREATE TABLE IF NOT EXISTS registry_meta\b/, ddl);
  assert.ok(ddl.includes("key TEXT PRIMARY KEY"), `meta ddl missing a primary key: ${ddl}`);
  assert.ok(ddl.includes("value TEXT"), `meta ddl missing a value column: ${ddl}`);
  assert.deepEqual(sql.stmts[1][1], [], "schema DDL binds nothing");
});

check("ensureRegistrySchema indexes the composite order listSessions sorts by (R54)", () => {
  const sql = newFake();
  ensureRegistrySchema(sql);
  const index = flat(sql.stmts[2][0]);
  assert.equal(
    index,
    "CREATE INDEX IF NOT EXISTS sessions_pinned_updated ON sessions (pinned DESC, updated_at DESC)"
  );
  assert.deepEqual(sql.stmts[2][1], []);
});

check("ensureRegistrySchema no longer ships the single-column index nothing uses", () => {
  const sql = newFake();
  ensureRegistrySchema(sql);
  for (const [query] of sql.stmts) {
    assert.equal(flat(query).includes("sessions_updated_at"), false, `dropped index survives: ${query}`);
  }
});

check("ensureRegistrySchema is idempotent as text, so a repeated onStart cannot fail", () => {
  const sql = newFake();
  ensureRegistrySchema(sql);
  ensureRegistrySchema(sql);
  assert.deepEqual(sql.stmts.slice(0, 3), sql.stmts.slice(3));
});

check("readRegistryMeta selects one value by key and answers null when the fake has no row", () => {
  const sql = newFake();
  assert.equal(readRegistryMeta(sql, "main_seeded"), null);
  const [query, bindings] = onlyStmt(sql);
  assert.equal(query, "SELECT value FROM registry_meta WHERE key = ?");
  assert.deepEqual(bindings, ["main_seeded"]);
});

check("readRegistryMeta returns the value stored under the key", () => {
  const sql = newFake();
  sql.query("FROM registry_meta", [{ key: "main_seeded", value: "1700000000000" }]);
  assert.equal(readRegistryMeta(sql, "main_seeded"), "1700000000000");
});

check("writeRegistryMeta inserts or replaces and reports no affected-row count", () => {
  const sql = newFake();
  assert.equal(writeRegistryMeta(sql, "main_seeded", "1700000000000"), undefined);
  const [query, bindings] = onlyStmt(sql);
  assert.equal(query, "INSERT OR REPLACE INTO registry_meta (key, value) VALUES (?, ?)");
  assert.deepEqual(bindings, ["main_seeded", "1700000000000"]);
});

check("upsertSession inserts all seven columns and updates on a known id", () => {
  const sql = newFake();
  assert.equal(upsertSession(sql, ROW), undefined);
  const [query, bindings] = onlyStmt(sql);
  assert.ok(
    query.startsWith(`INSERT INTO sessions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    query
  );
  assert.match(query, /\bON CONFLICT\(id\) DO UPDATE SET\b/, query);
  for (const column of ["title", "created_at", "updated_at", "workspace_ref", "unread", "pinned"]) {
    assert.ok(query.includes(`${column} = excluded.${column}`), `missing ${column}: ${query}`);
  }
  assert.deepEqual(bindings, ["abc123", "Drafts", 1000, 2000, null, 0, 0]);
});

check("upsertSession keeps the same statement text whatever the row is", () => {
  const sql = newFake();
  upsertSession(sql, ROW);
  upsertSession(sql, INJECTED);
  assert.equal(flat(sql.stmts[0][0]), flat(sql.stmts[1][0]));
  assert.deepEqual(sql.stmts[1][1], Object.values(INJECTED));
});

check("listSessions pins the sidebar order and passes the limit as a binding", () => {
  const sql = newFake();
  sql.query("FROM sessions", [ROW]);
  assert.deepEqual(listSessions(sql, 25), [ROW]);
  const [query, bindings] = onlyStmt(sql);
  assert.equal(
    query,
    `SELECT ${COLUMNS} FROM sessions ORDER BY pinned DESC, updated_at DESC LIMIT ?`
  );
  assert.deepEqual(bindings, [25]);
  assert.equal(query.includes("25"), false, "the limit leaked into the statement text");
});

check("listSessions changes only its binding when the limit changes", () => {
  const sql = newFake();
  listSessions(sql, 25);
  listSessions(sql, 7);
  assert.equal(flat(sql.stmts[0][0]), flat(sql.stmts[1][0]));
  assert.deepEqual(sql.stmts[0][1], [25]);
  assert.deepEqual(sql.stmts[1][1], [7]);
});

check("getSession selects by id and returns the row", () => {
  const sql = newFake();
  sql.query("WHERE id = ?", [ROW]);
  assert.deepEqual(getSession(sql, "abc123"), ROW);
  const [query, bindings] = onlyStmt(sql);
  assert.equal(query, `SELECT ${COLUMNS} FROM sessions WHERE id = ?`);
  assert.deepEqual(bindings, ["abc123"]);
});

check("getSession returns null, not undefined, for a missing row", () => {
  const sql = newFake();
  assert.equal(getSession(sql, "nope"), null);
});

check("renameSession sets the title by id and reports no affected-row count", () => {
  const sql = newFake();
  assert.equal(renameSession(sql, "abc123", "Renamed"), undefined);
  const [query, bindings] = onlyStmt(sql);
  assert.equal(query, "UPDATE sessions SET title = ? WHERE id = ?");
  assert.deepEqual(bindings, ["Renamed", "abc123"]);
});

check("touchSession without a delta bumps updated_at and clears unread (Task 33)", () => {
  const sql = newFake();
  assert.equal(touchSession(sql, "abc123", 5000), undefined);
  const [query, bindings] = onlyStmt(sql);
  assert.equal(query, "UPDATE sessions SET updated_at = ?, unread = 0 WHERE id = ?");
  assert.deepEqual(bindings, [5000, "abc123"]);
});

check("touchSession with an unreadDelta moves updated_at and unread in one statement", () => {
  const sql = newFake();
  assert.equal(touchSession(sql, "abc123", 6000, { unreadDelta: 3 }), undefined);
  const [query, bindings] = onlyStmt(sql);
  assert.equal(query, "UPDATE sessions SET updated_at = ?, unread = unread + ? WHERE id = ?");
  assert.deepEqual(bindings, [6000, 3, "abc123"]);
});

check("touchSession reads a negative delta the same way, so the column can move down", () => {
  const sql = newFake();
  touchSession(sql, "abc123", 7000, { unreadDelta: -4 });
  assert.deepEqual(onlyStmt(sql)[1], [7000, -4, "abc123"]);
});

check("touchSession keeps the delta form for an explicit zero, so 0 is not read as absent", () => {
  const sql = newFake();
  touchSession(sql, "abc123", 8000, { unreadDelta: 0 });
  assert.equal(
    onlyStmt(sql)[0],
    "UPDATE sessions SET updated_at = ?, unread = unread + ? WHERE id = ?"
  );
});

check("touchSession treats an empty options object as no delta", () => {
  const sql = newFake();
  touchSession(sql, "abc123", 9000, {});
  assert.equal(onlyStmt(sql)[0], "UPDATE sessions SET updated_at = ?, unread = 0 WHERE id = ?");
});

check("deleteSession removes by id and reports no affected-row count", () => {
  const sql = newFake();
  assert.equal(deleteSession(sql, "abc123"), undefined);
  const [query, bindings] = onlyStmt(sql);
  assert.equal(query, "DELETE FROM sessions WHERE id = ?");
  assert.deepEqual(bindings, ["abc123"]);
});

check("a title holding quotes and a semicolon round-trips as data, and never as SQL", () => {
  const sql = newFake();
  sql.query("WHERE id = ?", [INJECTED]);
  assert.equal(getSession(sql, "inj").title, INJECTION_TITLE);
  upsertSession(sql, INJECTED);
  assert.equal(sql.stmts[1][1].includes(INJECTION_TITLE), true, "title must arrive as a binding");
  for (const [query] of sql.stmts) {
    assert.equal(flat(query).includes("DROP TABLE"), false, `value leaked into: ${query}`);
  }
});

check("no statement has more or fewer placeholders than bindings, which is what db() enforces", () => {
  for (const sql of fakes) {
    for (const [query, bindings] of sql.stmts) {
      const placeholders = query.split("?").length - 1;
      assert.equal(
        placeholders,
        bindings.length,
        `${flat(query)} binds ${bindings.length} value(s) in ${placeholders} placeholder(s)`
      );
    }
  }
});

check("no bound string ever appears inside its own statement text", () => {
  for (const sql of fakes) {
    for (const [query, bindings] of sql.stmts) {
      for (const value of bindings) {
        if (typeof value !== "string" || value.length < 3) continue;
        assert.equal(
          flat(query).includes(value),
          false,
          `bound value ${JSON.stringify(value)} leaked into ${flat(query)}`
        );
      }
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

// node:sqlite hands back null-prototype rows, which strict deepEqual reads as a
// different shape than an object literal.
const plain = (row) => ({ ...row });

check("the schema statements execute, twice", () => {
  ensureRegistrySchema(real);
  ensureRegistrySchema(real);
});

check("upsertSession inserts a new row and reads back exactly what was written", () => {
  upsertSession(real, { ...ROW, workspace_ref: "ws-1", unread: 2, pinned: 1 });
  assert.deepEqual(plain(getSession(real, "abc123")), {
    ...ROW,
    workspace_ref: "ws-1",
    unread: 2,
    pinned: 1,
  });
});

check("upsertSession on a known id replaces the whole row, so the caller owns created_at", () => {
  upsertSession(real, {
    ...ROW,
    created_at: 12,
    updated_at: 50,
    title: "Second write",
    workspace_ref: "ws-2",
    unread: 7,
  });
  assert.deepEqual(plain(getSession(real, "abc123")), {
    id: "abc123",
    title: "Second write",
    created_at: 12,
    updated_at: 50,
    workspace_ref: "ws-2",
    unread: 7,
    pinned: 0,
  });
  assert.equal(
    listSessions(real, 10).filter((row) => row.id === "abc123").length,
    1,
    "the conflict path inserted a second row"
  );
});

check("listSessions returns pinned rows first, then most recently updated", () => {
  upsertSession(real, { ...ROW, id: "b", title: "b", updated_at: 40 });
  upsertSession(real, { ...ROW, id: "c", title: "c", updated_at: 30, pinned: 1 });
  assert.deepEqual(
    listSessions(real, 10).map((row) => [row.id, row.title, row.pinned]),
    [["c", "c", 1], ["abc123", "Second write", 0], ["b", "b", 0]]
  );
});

check("listSessions honours the bound limit", () => {
  assert.deepEqual(listSessions(real, 2).map((row) => row.id), ["c", "abc123"]);
});

check("renameSession writes the title and leaves the other columns alone", () => {
  const before = getSession(real, "b");
  renameSession(real, "b", "renamed 'quoted' title");
  const after = getSession(real, "b");
  assert.equal(after.title, "renamed 'quoted' title");
  assert.deepEqual({ ...after, title: before.title }, { ...before }, "rename touched more than the title");
});

check("touchSession moves updated_at and applies the unread delta to the stored value", () => {
  touchSession(real, "b", 60);
  assert.equal(getSession(real, "b").updated_at, 60);
  assert.equal(getSession(real, "b").unread, 0);
  touchSession(real, "b", 70, { unreadDelta: 2 });
  touchSession(real, "b", 80, { unreadDelta: 3 });
  assert.deepEqual(
    [getSession(real, "b").updated_at, getSession(real, "b").unread],
    [80, 5],
    "unread must accumulate, not be assigned"
  );
  renameSession(real, "b", "back to title");
  assert.equal(getSession(real, "b").unread, 5, "rename must not disturb unread");
});

check("an injected title is stored as data and the sessions table survives", () => {
  upsertSession(real, INJECTED);
  assert.equal(getSession(real, "inj").title, INJECTION_TITLE);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'").all().length, 1);
  assert.equal(listSessions(real, 10).length, 4);
});

check("deleteSession removes exactly the one row", () => {
  deleteSession(real, "inj");
  assert.equal(getSession(real, "inj"), null);
  assert.deepEqual(listSessions(real, 10).map((row) => row.id), ["c", "b", "abc123"]);
});

check("readRegistryMeta answers null for a key the database never wrote", () => {
  assert.equal(readRegistryMeta(real, "main_seeded"), null);
});

check("writeRegistryMeta then readRegistryMeta round-trips the value", () => {
  writeRegistryMeta(real, "round_trip", "1700000000000");
  assert.equal(readRegistryMeta(real, "round_trip"), "1700000000000");
  assert.equal(readRegistryMeta(real, "another_key"), null, "a write leaked into another key");
});

check("a second writeRegistryMeta for the same key replaces rather than duplicates", () => {
  writeRegistryMeta(real, "round_trip", "1700000009999");
  assert.equal(readRegistryMeta(real, "round_trip"), "1700000009999");
  assert.equal(
    db.prepare("SELECT value FROM registry_meta WHERE key = 'round_trip'").all().length,
    1,
    "the second write inserted a second row under one primary key"
  );
});

check("re-running ensureRegistrySchema keeps the registry_meta rows already there", () => {
  writeRegistryMeta(real, "main_seeded", "1700000000000");
  ensureRegistrySchema(real);
  ensureRegistrySchema(real);
  assert.equal(readRegistryMeta(real, "main_seeded"), "1700000000000");
  assert.equal(readRegistryMeta(real, "round_trip"), "1700000009999");
  assert.equal(
    db.prepare("SELECT count AS n FROM (SELECT COUNT(*) AS count FROM registry_meta)").all()[0].n,
    2,
    "the schema re-run duplicated or dropped a meta row"
  );
});

check("the sessions rows survive the same re-run", () => {
  ensureRegistrySchema(real);
  assert.equal(getSession(real, "abc123").title, "Second write");
});

db.close();

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`registry-store: ${failures.length} failed`);
  process.exit(1);
}
