// In-memory fake of the SqlHandle declared in src/memory.ts, for offline store tests.
// Dependency-free so plain Node can import it with no build step.
//
//   const sql = fakeSql();
//   sql.query("FROM sessions", [{ id: "a" }]);      // seed rows a SELECT answers with
//   sql.query("DELETE FROM sessions", [], 1);       // declare the affected-row count
//   sql.exec("SELECT * FROM sessions LIMIT ?", 5);
//     // -> { results: [{ id: "a" }], meta: { changes: 0 } }
//   sql.stmts    // one [query, bindings] pair per exec, in call order
//   sql.results  // one { results, meta } reply per exec, in call order
//
// rowsFor answers SELECT statements ONLY. A write (INSERT/UPDATE/DELETE) returns
// { results: [] } even when its text contains a seeded needle, which is what the
// real ctx.storage.sql does, so a store test cannot pass on a seed its DELETE
// also matched. changes is the optional third argument to query(needle, rows,
// changes), defaults to 0, and is meant for write needles.

const SELECT_RE = /^\s*select\b/i;

// First registered needle that the statement text contains wins.
function firstMatch(seeded, query) {
  for (const [needle, entry] of seeded) {
    if (query.includes(needle)) return entry;
  }
  return undefined;
}

export function fakeSql() {
  const seeded = new Map();
  return {
    results: [],
    stmts: [],
    seeded,

    query(needle, rows, changes = 0) {
      seeded.set(needle, { rows, changes });
      return this;
    },

    exec(query, ...bindings) {
      this.stmts.push([query, bindings]);
      const reply = { results: this.rowsFor(query), meta: { changes: this.changesFor(query) } };
      this.results.push(reply);
      return reply;
    },

    rowsFor(query) {
      if (!SELECT_RE.test(query)) return [];
      const hit = firstMatch(seeded, query);
      return hit ? hit.rows.slice() : [];
    },

    changesFor(query) {
      const hit = firstMatch(seeded, query);
      return hit ? hit.changes : 0;
    },
  };
}
