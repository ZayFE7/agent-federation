// Contract test for the tests/fake-sql.mjs fixture that the store tasks build on.
// Proves: stmts order, the results log, rows.slice() copy semantics, first-needle-
// wins, SELECT-only answering, and the meta.changes field.
// Run: node tests/fake-sql.test.mjs   (exit 0 pass / 1 fail, no framework)
import { fakeSql } from "./fake-sql.mjs";

let pass = 0,
  fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass++;
    console.log("  PASS " + label);
  } else {
    fail++;
    console.log("  FAIL " + label + (detail ? "  -> " + detail : ""));
  }
}
const json = (v) => JSON.stringify(v);

const SELECT_A = "SELECT id FROM sessions ORDER BY updated_at DESC LIMIT ?";
const DELETE_A = "DELETE FROM sessions WHERE id = ?";
const SEED_ROWS = [{ id: "a" }, { id: "b" }];

// ---- seeding and the reply shape ----
const s = fakeSql();
check("query() returns the fake for chaining", s.query("FROM sessions", SEED_ROWS) === s);

const r1 = s.exec(SELECT_A, 10);
check("seeded SELECT rows come back", json(r1.results) === json(SEED_ROWS), json(r1.results));
check("reply carries meta.changes", r1.meta && typeof r1.meta.changes === "number", json(r1));
check("changes defaults to 0", r1.meta.changes === 0, json(r1.meta));
check("bindings are recorded, not interpolated", s.stmts.length === 1 &&
  s.stmts[0][0] === SELECT_A && json(s.stmts[0][1]) === json([10]), json(s.stmts));
check("results logs every exec", s.results.length === 1 && s.results[0] === r1, json(s.results));

// ---- repeat exec + copy semantics ----
const r2 = s.exec(SELECT_A, 5);
check("repeat exec still returns the seed", json(r2.results) === json(SEED_ROWS), json(r2.results));
check("stmts keep call order", s.stmts.length === 2 && s.stmts[1][1][0] === 5, json(s.stmts));
check("results log grows one per exec", s.results.length === 2 &&
  s.results[0] === r1 && s.results[1] === r2, json(s.results.map((x) => x.results.length)));

const reply = s.exec(SELECT_A, 1).results;
reply.push({ id: "injected" });
const r3 = s.exec(SELECT_A, 1).results;
check("reply array is a slice copy, seed length untouched", json(r3) === json(SEED_ROWS), json(r3));
check("the seeded array itself was not extended",
  s.seeded.get("FROM sessions").rows.length === 2, json(s.seeded.get("FROM sessions").rows));
check("row objects are shared, so the copy is shallow", r3[0] === SEED_ROWS[0]);

// ---- unseeded ----
check("unseeded SELECT returns []", json(s.exec("SELECT id FROM memories").results) === json([]));

// ---- first needle wins ----
const f = fakeSql();
f.query("FROM sessions", [{ id: "first" }]).query("ORDER BY updated_at", [{ id: "second" }]);
const won = f.exec("SELECT id FROM sessions ORDER BY updated_at DESC").results;
check("first registered needle wins", json(won) === json([{ id: "first" }]), json(won));

// ---- SELECT-only answering (writes must not read a seed) ----
const w = fakeSql();
w.query("FROM sessions", SEED_ROWS);
const del = w.exec(DELETE_A, "z");
check("DELETE containing a SELECT needle returns []", json(del.results) === json([]), json(del));
w.query("INTO sessions", SEED_ROWS);
check("INSERT does not answer a SELECT-only fixture",
  json(w.exec("INSERT INTO sessions (id) VALUES (?)", "z").results) === json([]));
check("UPDATE returns []", json(w.exec("UPDATE sessions SET title = ? WHERE id = ?", "t", "z").results) === json([]));
check("CREATE TABLE returns []", json(w.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT)").results) === json([]));
check("writes are still recorded in stmts", w.stmts.length === 4, json(w.stmts.map((x) => x[0])));
check("a write on an unseeded needle reports changes 0", del.meta.changes === 0, json(del.meta));

// ---- the gate itself ----
const g = fakeSql();
g.query("FROM t", [{ n: 1 }]);
check("leading whitespace + lowercase select is a SELECT",
  json(g.exec("\n  select n FROM t").results) === json([{ n: 1 }]));
check("uppercase SELECT is a SELECT", json(g.exec("SELECT n FROM t").results) === json([{ n: 1 }]));
check("a word starting with select is not a SELECT",
  json(g.exec("SELECTOR n FROM t").results) === json([]));
check("rowsFor mirrors exec for SELECTs", json(g.rowsFor("SELECT n FROM t")) === json([{ n: 1 }]) &&
  json(g.rowsFor("DROP TABLE t")) === json([]));

// ---- declared changes (Task 6 deleteSession / renameSession) ----
const c = fakeSql();
c.query("DELETE FROM sessions", [], 1).query("UPDATE sessions", [], 3);
const one = c.exec(DELETE_A, "a");
check("declared changes comes back on exec", one.meta.changes === 1, json(one));
const three = c.exec("UPDATE sessions SET title = ? WHERE id = ?", "x", "a");
check("second write needle keeps its own changes", three.meta.changes === 3, json(three));
check("undeclared write needle still returns 0",
  c.exec("DELETE FROM memories WHERE id = ?", "m").meta.changes === 0);
check("the declared write reply is still empty results", json(one.results) === json([]) &&
  json(three.results) === json([]));
check("changes log is per exec, in order",
  json(c.results.map((x) => x.meta.changes)) === json([1, 3, 0]), json(c.results));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
