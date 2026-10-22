// Pure session-index store over a SqlHandle: the sessions table and its CRUD.
// Mirrors src/memory.ts and stays dependency-free (types only, no runtime import)
// so plain Node can import and test it with no build step.
// Nothing here reports affected-row counts: the platform's cursor exposes
// rowsRead/rowsWritten and no per-statement count, and the shared exec adapter
// src/sql-handle.ts returns { results } and nothing else (R37).

import type { SqlHandle } from "./memory";

export interface SessionRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  workspace_ref: string | null;
  unread: number;
  pinned: number;
}

/**
 * Title a session is created with. One constant because Task 6 seeds it and
 * Task 9 renames a thread only while its title still equals this.
 */
export const PLACEHOLDER_TITLE = "New session";

const SELECT_COLUMNS =
  "id, title, created_at, updated_at, workspace_ref, unread, pinned";

/**
 * Idempotent schema for the session index: the sessions table, the one-row
 * registry_meta table, and the composite index the sidebar's only query needs.
 *
 * The DDL lives here, in the store, so both routes into it get the same schema: a
 * Durable Object's lazy `db()` guard runs this and its onStart() goes through
 * `db()` as well, so nothing can end up holding the table without the index
 * (R54, ruled again in R64). Task 5 shipped `sessions_updated_at ON sessions
 * (updated_at)`, which cannot serve `ORDER BY pinned DESC, updated_at DESC`; it is
 * dropped, because the sidebar's only query is the composite ordering and nothing
 * else in the project reads updated_at alone.
 */
export function ensureRegistrySchema(sql: SqlHandle): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    workspace_ref TEXT,
    unread INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS registry_meta (key TEXT PRIMARY KEY, value TEXT)`);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS sessions_pinned_updated ON sessions (pinned DESC, updated_at DESC)`
  );
}

/**
 * One persisted marker row, read as a string, or null when the key was never
 * written. Outlives the DO instance it describes, which is the whole point: a
 * one-shot boot decision kept in memory is exactly what a cold start destroys.
 */
export function readRegistryMeta(sql: SqlHandle, key: string): string | null {
  const row = sql.exec<{ key: string; value: string | null }>(
    "SELECT value FROM registry_meta WHERE key = ?",
    key
  ).results[0];
  return row === undefined ? null : row.value;
}

/** Replace the value for a known key rather than failing or duplicating it. */
export function writeRegistryMeta(sql: SqlHandle, key: string, value: string): void {
  sql.exec("INSERT OR REPLACE INTO registry_meta (key, value) VALUES (?, ?)", key, value);
}

/**
 * Write a whole row. Re-putting a known id replaces it rather than failing, so
 * the caller owns every column it sends, created_at included.
 */
export function upsertSession(sql: SqlHandle, row: SessionRow): void {
  sql.exec(
    `INSERT INTO sessions (${SELECT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       workspace_ref = excluded.workspace_ref,
       unread = excluded.unread,
       pinned = excluded.pinned`,
    row.id,
    row.title,
    row.created_at,
    row.updated_at,
    row.workspace_ref,
    row.unread,
    row.pinned
  );
}

/** Newest first, pinned rows ahead of everything else. */
export function listSessions(sql: SqlHandle, limit: number): SessionRow[] {
  return sql.exec<SessionRow>(
    `SELECT ${SELECT_COLUMNS} FROM sessions
     ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
    limit
  ).results;
}

export function getSession(sql: SqlHandle, id: string): SessionRow | null {
  return (
    sql.exec<SessionRow>(
      `SELECT ${SELECT_COLUMNS} FROM sessions WHERE id = ?`,
      id
    ).results[0] ?? null
  );
}

export function renameSession(sql: SqlHandle, id: string, title: string): void {
  sql.exec("UPDATE sessions SET title = ? WHERE id = ?", title, id);
}

/**
 * Bump updated_at, and unread as well when opts.unreadDelta is present. A delta
 * of 0 takes the same statement as any other value; only an absent key skips it.
 *
 * The no-delta form is the read marker, not just a clock bump: the two callers
 * that use it are the worker's accepted send and the console opening a chat, and
 * in both cases the user is looking at that session, so anything queued on it
 * stops being unread (Task 33).
 */
export function touchSession(
  sql: SqlHandle,
  id: string,
  now: number,
  opts?: { unreadDelta?: number }
): void {
  if (opts?.unreadDelta === undefined) {
    sql.exec("UPDATE sessions SET updated_at = ?, unread = 0 WHERE id = ?", now, id);
    return;
  }
  sql.exec(
    "UPDATE sessions SET updated_at = ?, unread = unread + ? WHERE id = ?",
    now,
    opts.unreadDelta,
    id
  );
}

export function deleteSession(sql: SqlHandle, id: string): void {
  sql.exec("DELETE FROM sessions WHERE id = ?", id);
}
