// Contract tests for src/sql-handle.ts, the one exec adapter both Durable Objects
// build their db() from (src/agent.ts and src/registry.ts).
// Plain Node, no framework, no build step: run with `node tests/sql-handle.test.mjs`.
// Node 22.6+/24 strips the .ts types on import, so this needs nothing else.
//
// The tag here is built from a real node:sqlite prepared statement, which is the
// closest offline stand-in for the SDK's this.sql: it takes a template literal and
// returns the rows. This behavior was never tested directly, because neither DO
// that depended on it is importable by Node.
//
// Silent on success (exit 0). Prints every failure and exits 1 otherwise.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { toSqlHandle } from "../src/sql-handle.ts";

const failures = [];

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t (id INTEGER, name TEXT)");
db.exec("INSERT INTO t VALUES (1, 'alpha'), (2, 'beta'), (3, NULL)");

// What the tag last received, so a test can assert the query text and the bindings
// as the adapter handed them over, not as the caller wrote them.
let seen = null;

// The SDK's contract in three lines: a template tag joins its chunks on "?" for
// each value and returns the rows it read.
function tag(strings, ...values) {
  seen = { strings, values, query: [...strings].join("?") };
  return db.prepare(seen.query).all(...values);
}

const sql = toSqlHandle(tag);

check("a bound SELECT returns the row and results is an array of objects", () => {
  const reply = sql.exec("SELECT id, name FROM t WHERE id = ?", 2);
  assert.equal(Array.isArray(reply.results), true, "results is not an array");
  assert.deepEqual({ ...reply.results[0] }, { id: 2, name: "beta" });
  assert.deepEqual(Object.keys(reply), ["results"], "a reply must carry results and nothing else (R37, R58)");
  assert.deepEqual(seen.values, [2]);
  assert.equal(seen.query, "SELECT id, name FROM t WHERE id = ?");
});

check("the template chunks arrive with the raw property a tag expects", () => {
  sql.exec("SELECT id FROM t WHERE id IN (?, ?)", 1, 3);
  assert.equal(Array.isArray(seen.strings), true, "the first argument is not an array");
  assert.deepEqual([...seen.strings], ["SELECT id FROM t WHERE id IN (", ", ", ")"]);
  assert.ok(Array.isArray(seen.strings.raw), "no raw array, so a real tag would throw");
  assert.deepEqual([...seen.strings.raw], [...seen.strings]);
  assert.deepEqual(seen.values, [1, 3]);
  assert.equal(seen.query, "SELECT id FROM t WHERE id IN (?, ?)");
  assert.equal(sql.exec("SELECT id FROM t WHERE id = ?", 1).results.length, 1);
});

check("too many bindings throws and the message names both counts", () => {
  assert.throws(
    () => sql.exec("SELECT id FROM t WHERE id = ?", 1, 2),
    (err) => {
      assert.match(err.message, /SQL placeholder mismatch: 1 placeholders, 2 bindings/);
      return true;
    }
  );
});

check("too few bindings throws with the counts the other way round", () => {
  assert.throws(
    () => sql.exec("SELECT id FROM t WHERE id = ? AND name = ?", 1),
    (err) => {
      assert.match(err.message, /SQL placeholder mismatch: 2 placeholders, 1 bindings/);
      return true;
    }
  );
});

check("a mismatch never reaches the tag, so nothing misbinds", () => {
  seen = null;
  assert.throws(() => sql.exec("SELECT id FROM t WHERE id = ?", 1, 2, 3), /placeholder mismatch/);
  assert.equal(seen, null, "the tag ran even though the counts disagreed");
});

check("a query with no placeholder and no bindings passes straight through", () => {
  const reply = sql.exec("SELECT name FROM t ORDER BY id");
  assert.equal(reply.results.length, 3);
  assert.equal(seen.query, "SELECT name FROM t ORDER BY id");
  assert.deepEqual(seen.values, []);
});

check("null bindings survive the round trip", () => {
  const found = sql.exec("SELECT id FROM t WHERE name IS ?", null);
  assert.deepEqual([...seen.values], [null]);
  assert.deepEqual(found.results.map((row) => ({ ...row })), [{ id: 3 }]);
  const projection = sql.exec("SELECT ? AS v", null);
  assert.equal(projection.results.length, 1, "a constant projection must return one row");
  assert.equal(projection.results[0].v, null, "the null binding was not passed through");
});

check("a null binding sits beside a non-null one without shifting the order", () => {
  sql.exec("INSERT INTO t (id, name) VALUES (?, ?)", 4, null);
  assert.deepEqual(seen.values, [4, null], "the bindings arrived out of order");
  const reply = sql.exec("SELECT id, name FROM t WHERE id = ?", 4);
  assert.deepEqual([reply.results[0].id, reply.results[0].name], [4, null]);
});

db.close();

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`sql-handle: ${failures.length} failed`);
  process.exit(1);
}
