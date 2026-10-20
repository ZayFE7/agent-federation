// In-memory fake of the SqlHandle declared in src/memory.ts, for offline store tests.
// Dependency-free so plain Node can import it with no build step.
//
//   const sql = fakeSql();
//   sql.query("FROM sessions", [{ id: "a" }]);   // seed rows a SELECT answers with
//   sql.exec("SELECT * FROM sessions LIMIT ?", 5);
//     // -> { results: [{ id: "a" }] }
//   sql.stmts    // one [query, bindings] pair per exec, in call order
//   sql.results  // one { results } reply per exec, in call order
//
// rowsFor answers SELECT statements ONLY. A write (INSERT/UPDATE/DELETE) returns
// { results: [] } even when its text contains a seeded needle, which is what the
// real ctx.storage.sql does, so a store test cannot pass on a seed its DELETE
// also matched. A reply carries `results` and nothing else: the platform's
// SqlStorageCursor exposes rowsRead/rowsWritten and no per-statement affected-row
// count, and the adapter in src/agent.ts returns { results }, so a fake that
// invented meta.changes would let a test pass against an interface production
// cannot supply (R37).

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

    query(needle, rows) {
      seeded.set(needle, { rows });
      return this;
    },

    exec(query, ...bindings) {
      this.stmts.push([query, bindings]);
      const reply = { results: this.rowsFor(query) };
      this.results.push(reply);
      return reply;
    },

    rowsFor(query) {
      if (!SELECT_RE.test(query)) return [];
      const hit = firstMatch(seeded, query);
      return hit ? hit.rows.slice() : [];
    },
  };
}
