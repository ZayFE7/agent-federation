// Pointer store: what the last good workspace snapshot for a session was.
//
// The archive itself lives in KV (`ws:tar:<session>`, written by the sandbox
// worker). KV is the cheap place for payload but it is not the truth you can act
// on: a read right after a write can be up to 60 s stale on the free plan, and a
// listing is rationed to 1,000 calls a day. This table is the strongly consistent
// row the agent DO already has, and it says the one thing the next snapshot and
// the Files tab both need: which key holds the current tree, how big it is, how
// many files, and its digest so an unchanged tree costs zero KV writes.
//
// Two facts are kept apart on purpose. `key`/`bytes`/`files`/`sha256` describe the
// last snapshot that LANDED. `over_limit_bytes` is a warning about the most recent
// attempt that did not, and it survives a later failed attempt because a session
// that has outgrown the ceiling needs to be told, not forgotten.
//
// Pure SQL over SqlHandle in the src/vault.ts idiom, every value a `?` binding, so
// an offline test can run it on real SQLite. Note R37: `sql.exec()` reports
// `results` and nothing else, so there is no `changes` count to test an UPDATE
// against. Anything that has to preserve a row it may not have found reads first.

import type { SqlHandle } from "./memory";

export interface WorkspaceRow {
  session_id: string;
  /** The KV entry name holding the tar, e.g. `ws:tar:main`. */
  key: string;
  /** Compressed bytes stored under `key`. */
  bytes: number;
  files: number;
  sha256: string;
  /** When that archive landed, in epoch ms. */
  updated_at: number;
  /** Measured size of the latest attempt that was over the ceiling, else null. */
  over_limit_bytes: number | null;
}

export function ensureWorkspaceSchema(sql: SqlHandle): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS workspace_state (
    session_id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    files INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    over_limit_bytes INTEGER
  )`);
}

export function getWorkspace(sql: SqlHandle, sessionId: string): WorkspaceRow | null {
  const rows = sql.exec<WorkspaceRow>(
    "SELECT session_id, key, bytes, files, sha256, updated_at, over_limit_bytes FROM workspace_state WHERE session_id = ?",
    sessionId
  ).results;
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Record the snapshot that just landed. `over_limit_bytes` is cleared here rather
 * than copied from the caller: an archive that fits is, by definition, no longer
 * over the limit, and a stale warning on a good pointer would keep telling the user
 * their workspace is too big after they fixed it.
 */
export function recordSnapshot(sql: SqlHandle, row: WorkspaceRow): void {
  sql.exec(
    `INSERT OR REPLACE INTO workspace_state
      (session_id, key, bytes, files, sha256, updated_at, over_limit_bytes)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    row.session_id,
    row.key,
    row.bytes,
    row.files,
    row.sha256,
    row.updated_at
  );
}

/**
 * Remember that the newest attempt did not fit. The pointer to the last good
 * archive is kept untouched, because it is still what a restore would use. There
 * is no `changes` count to branch on (R37), so this reads before it writes.
 */
export function recordTooLarge(
  sql: SqlHandle,
  sessionId: string,
  bytes: number,
  at: number
): void {
  const existing = getWorkspace(sql, sessionId);
  if (existing) {
    sql.exec(
      "UPDATE workspace_state SET over_limit_bytes = ? WHERE session_id = ?",
      bytes,
      sessionId
    );
    return;
  }
  sql.exec(
    `INSERT OR REPLACE INTO workspace_state
      (session_id, key, bytes, files, sha256, updated_at, over_limit_bytes)
     VALUES (?, '', 0, 0, '', ?, ?)`,
    sessionId,
    at,
    bytes
  );
}

/** Forget the pointer: used when the session's snapshots are deleted for real. */
export function clearWorkspace(sql: SqlHandle, sessionId: string): void {
  sql.exec("DELETE FROM workspace_state WHERE session_id = ?", sessionId);
}
