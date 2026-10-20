// Adapter from the Agents SDK's tagged-template this.sql(strings, ...values) to
// the exec-style SqlHandle the pure stores take. Extracted from the two copies of
// the same 27-line adapter: `db()` in src/agent.ts and `db()` in src/registry.ts.
//
// Dependency-free by rule: types only, no runtime import, so plain Node can
// import and execute this module (tests/sql-handle.test.mjs). Neither DO that
// uses it is importable offline, because both value-import `agents`, which pulls
// in `cloudflare:workers` (the plan's D6 limit, restated in progress.md R47).
//
// A reply carries `results` and nothing else: the platform's cursor exposes
// rowsRead/rowsWritten and no per-statement affected-row count (R37, R58).

import type { SqlHandle } from "./memory";

/** The SDK's own call shape: a template tag that returns the rows it read. */
export type SqlTag = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => unknown[];

/**
 * The SDK rebuilds the query by joining the string chunks with "?" for each
 * value, so an exec-style query must be split on its existing placeholders
 * first, and a placeholder/bindings mismatch throws instead of misbinding.
 */
export function toSqlHandle(sqlTag: SqlTag): SqlHandle {
  return {
    exec<T = Record<string, unknown>>(
      query: string,
      ...bindings: Array<string | number | null>
    ) {
      const parts = query.split("?");
      if (parts.length !== bindings.length + 1) {
        throw new Error(
          `SQL placeholder mismatch: ${parts.length - 1} placeholders, ${bindings.length} bindings`
        );
      }
      const strings = Object.assign(parts, { raw: [...parts] }) as unknown as TemplateStringsArray;
      const rows = sqlTag(strings, ...bindings) as T[];
      return { results: rows };
    },
  };
}
