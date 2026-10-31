// Global skill storage. Pure SQL over SqlHandle so a real SQLite test can drive it.

import type { SqlHandle } from "./memory";

export interface SkillRow {
  id: string;
  name: string;
  description: string;
  body: string;
  source: string;
  file_count: number;
  bytes: number;
  created_at: number;
  updated_at: number;
}

export interface SkillFileRow {
  skill_id: string;
  path: string;
  bytes: number;
  content_b64: string;
}

export interface SkillFileInput {
  path: string;
  bytes: number;
  contentBase64: string;
}

// Durable Object SQLite caps one row at 2 MB. Base64 inflates by 4/3, so a
// package file larger than this is stored as consecutive chunks instead of one
// row that the platform would refuse.
const CHUNK_CHARS = 768 * 1024;

export function ensureSkillSchema(sql: SqlHandle): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    body TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    file_count INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  for (const column of [
    "source TEXT NOT NULL DEFAULT ''",
    "file_count INTEGER NOT NULL DEFAULT 0",
    "bytes INTEGER NOT NULL DEFAULT 0",
  ]) {
    try {
      sql.exec(`ALTER TABLE skills ADD COLUMN ${column}`);
    } catch {
      // duplicate column name: already migrated.
    }
  }
  sql.exec(`CREATE TABLE IF NOT EXISTS skill_files (
    skill_id TEXT NOT NULL,
    path TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    content_b64 TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (skill_id, path)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS skill_file_chunks (
    skill_id TEXT NOT NULL,
    path TEXT NOT NULL,
    idx INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (skill_id, path, idx)
  )`);
}

export function listSkillRows(sql: SqlHandle): SkillRow[] {
  return sql.exec<SkillRow>(
    "SELECT id, name, description, body, source, file_count, bytes, created_at, updated_at FROM skills ORDER BY name ASC"
  ).results;
}

export function getSkillRow(sql: SqlHandle, name: string): SkillRow | null {
  return (
    sql.exec<SkillRow>(
      "SELECT id, name, description, body, source, file_count, bytes, created_at, updated_at FROM skills WHERE name = ?",
      name
    ).results[0] ?? null
  );
}

export function listSkillFileRows(sql: SqlHandle, skillId: string): SkillFileRow[] {
  const files = sql.exec<Omit<SkillFileRow, "content_b64"> & { content_b64: string }>(
    "SELECT skill_id, path, bytes, content_b64 FROM skill_files WHERE skill_id = ? ORDER BY path ASC",
    skillId
  ).results;
  const chunks = sql.exec<{ path: string; idx: number; data: string }>(
    "SELECT path, idx, data FROM skill_file_chunks WHERE skill_id = ? ORDER BY path ASC, idx ASC",
    skillId
  ).results;
  if (chunks.length === 0) return files as SkillFileRow[];
  const joined = new Map<string, string>();
  for (const chunk of chunks) {
    joined.set(chunk.path, (joined.get(chunk.path) ?? "") + chunk.data);
  }
  return files.map((file) => ({
    ...file,
    content_b64: file.content_b64 || joined.get(file.path) || "",
  }));
}

export function countSkills(sql: SqlHandle): number {
  return Number(
    sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM skills").results[0]?.count ?? 0
  );
}

export function upsertSkillRow(sql: SqlHandle, row: SkillRow): void {
  sql.exec(
    `INSERT INTO skills (id, name, description, body, source, file_count, bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       body = excluded.body,
       source = excluded.source,
       file_count = excluded.file_count,
       bytes = excluded.bytes,
       updated_at = excluded.updated_at`,
    row.id,
    row.name,
    row.description,
    row.body,
    row.source,
    row.file_count,
    row.bytes,
    row.created_at,
    row.updated_at
  );
}

export function upsertSkillFiles(
  sql: SqlHandle,
  skillId: string,
  files: readonly SkillFileInput[]
): void {
  sql.exec("DELETE FROM skill_files WHERE skill_id = ?", skillId);
  sql.exec("DELETE FROM skill_file_chunks WHERE skill_id = ?", skillId);
  for (const file of files) {
    const chunked = file.contentBase64.length > CHUNK_CHARS;
    sql.exec(
      "INSERT INTO skill_files (skill_id, path, bytes, content_b64) VALUES (?, ?, ?, ?)",
      skillId,
      file.path,
      file.bytes,
      chunked ? "" : file.contentBase64
    );
    if (!chunked) continue;
    let idx = 0;
    for (let at = 0; at < file.contentBase64.length; at += CHUNK_CHARS) {
      sql.exec(
        "INSERT INTO skill_file_chunks (skill_id, path, idx, data) VALUES (?, ?, ?, ?)",
        skillId,
        file.path,
        idx++,
        file.contentBase64.slice(at, at + CHUNK_CHARS)
      );
    }
  }
}

export function deleteSkillRow(sql: SqlHandle, name: string): boolean {
  const existing = getSkillRow(sql, name);
  if (!existing) return false;
  sql.exec("DELETE FROM skill_file_chunks WHERE skill_id = ?", name);
  sql.exec("DELETE FROM skill_files WHERE skill_id = ?", name);
  sql.exec("DELETE FROM skills WHERE name = ?", name);
  return true;
}
