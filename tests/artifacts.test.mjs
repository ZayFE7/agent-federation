// The artifact marker table: upsert by path, newest first, delete by path.
// Plain Node with a real SQLite, like tests/skills.test.mjs.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  deleteArtifactByPath,
  ensureArtifactSchema,
  listArtifactRows,
  upsertArtifact,
} from "../src/artifact-store.ts";

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log("  PASS " + name);
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
    console.log("  FAIL " + name);
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

check("the schema is idempotent", () => {
  ensureArtifactSchema(sql);
  ensureArtifactSchema(sql);
});

check("upsert keeps one row per path and updates its title", () => {
  upsertArtifact(sql, { path: "report.pdf", title: "Report", bytes: 100, created_at: 1 });
  upsertArtifact(sql, { path: "report.pdf", title: "Final report", bytes: 200, created_at: 2 });
  const rows = listArtifactRows(sql);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Final report");
  assert.equal(rows[0].bytes, 200);
});

check("the newest artifact is first and the limit is clamped", () => {
  upsertArtifact(sql, { path: "old.png", title: "Old", bytes: 10, created_at: 1 });
  upsertArtifact(sql, { path: "new.png", title: "New", bytes: 20, created_at: 3 });
  const rows = listArtifactRows(sql);
  assert.deepEqual(rows.map((r) => r.path), ["new.png", "report.pdf", "old.png"]);
  assert.equal(listArtifactRows(sql, 2).length, 2);
});

check("delete by path removes only that marker", () => {
  deleteArtifactByPath(sql, "report.pdf");
  assert.deepEqual(listArtifactRows(sql).map((r) => r.path), ["new.png", "old.png"]);
});

if (failures.length) {
  for (const failure of failures) console.error("  FAIL " + failure);
  process.exit(1);
}
console.log("artifacts: passed");
