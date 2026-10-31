// Session artifact markers: the files the agent explicitly shared with the user.
// Pure SQL over SqlHandle so a real SQLite test can drive it.

import type { SqlHandle } from "./memory";

export interface ArtifactRow {
  id: number;
  path: string;
  title: string;
  bytes: number;
  created_at: number;
}

export function ensureArtifactSchema(sql: SqlHandle): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
}

export function upsertArtifact(
  sql: SqlHandle,
  artifact: { path: string; title: string; bytes: number; created_at?: number }
): void {
  sql.exec(
    `INSERT INTO artifacts (path, title, bytes, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       title = excluded.title,
       bytes = excluded.bytes,
       created_at = excluded.created_at`,
    artifact.path,
    artifact.title,
    artifact.bytes,
    artifact.created_at ?? Date.now()
  );
}

export function listArtifactRows(sql: SqlHandle, limit = 100): ArtifactRow[] {
  return sql.exec<ArtifactRow>(
    "SELECT id, path, title, bytes, created_at FROM artifacts ORDER BY created_at DESC, id DESC LIMIT ?",
    Math.max(1, Math.min(200, Math.floor(limit) || 100))
  ).results;
}

export function deleteArtifactByPath(sql: SqlHandle, path: string): void {
  sql.exec("DELETE FROM artifacts WHERE path = ?", path);
}
