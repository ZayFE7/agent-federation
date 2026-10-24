// Global skill storage. Pure SQL over SqlHandle so a real SQLite test can drive it.

import type { SqlHandle } from "./memory";

export interface SkillRow {
  id: string;
  name: string;
  description: string;
  body: string;
  created_at: number;
  updated_at: number;
}

export function ensureSkillSchema(sql: SqlHandle): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

export function listSkillRows(sql: SqlHandle): SkillRow[] {
  return sql.exec<SkillRow>(
    "SELECT id, name, description, body, created_at, updated_at FROM skills ORDER BY name ASC"
  ).results;
}

export function getSkillRow(sql: SqlHandle, name: string): SkillRow | null {
  return (
    sql.exec<SkillRow>(
      "SELECT id, name, description, body, created_at, updated_at FROM skills WHERE name = ?",
      name
    ).results[0] ?? null
  );
}

export function countSkills(sql: SqlHandle): number {
  return Number(
    sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM skills").results[0]?.count ?? 0
  );
}

export function upsertSkillRow(sql: SqlHandle, row: SkillRow): void {
  sql.exec(
    `INSERT INTO skills (id, name, description, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       body = excluded.body,
       updated_at = excluded.updated_at`,
    row.id,
    row.name,
    row.description,
    row.body,
    row.created_at,
    row.updated_at
  );
}

export function deleteSkillRow(sql: SqlHandle, name: string): boolean {
  const existing = getSkillRow(sql, name);
  if (!existing) return false;
  sql.exec("DELETE FROM skills WHERE name = ?", name);
  return true;
}
