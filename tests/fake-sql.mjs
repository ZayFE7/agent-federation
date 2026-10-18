// In-memory fake of the SqlHandle declared in src/memory.ts, for offline store tests.
// Dependency-free so plain Node can import it with no build step.
//
//   const sql = fakeSql();
//   sql.query("FROM sessions", [{ id: "a" }]);        // seed rows, keyed by substring
//   sql.exec("SELECT * FROM sessions LIMIT ?", 5);    // -> { results: [{ id: "a" }] }
//   sql.stmts    // one [query, bindings] pair per exec, in call order
//   sql.results  // one { results } object per exec, in call order

export function fakeSql() {
  const seeded = new Map();
  return {
    results: [],
    stmts: [],
    seeded,

    // Seed the rows returned by any statement whose text contains `needle`.
    query(needle, rows) {
      seeded.set(needle, rows);
      return this;
    },

    exec(query, ...bindings) {
      this.stmts.push([query, bindings]);
      const reply = { results: this.rowsFor(query) };
      this.results.push(reply);
      return reply;
    },

    // First matching seed wins; a statement nobody seeded returns [].
    rowsFor(query) {
      for (const [needle, rows] of seeded) {
        if (query.includes(needle)) return rows.slice();
      }
      return [];
    },
  };
}
