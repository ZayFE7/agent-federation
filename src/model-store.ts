// Pure storage for model providers and the global default. The API key column
// holds ciphertext only; encryption happens in src/registry.ts, not here.

import type { SqlHandle } from "./memory";

export interface ModelProviderRow {
  id: string;
  name: string;
  base_url: string;
  api_key_enc: string;
  models_json: string;
  created_at: number;
  updated_at: number;
}

export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

export interface ModelDefault {
  provider: string;
  model: string;
}

export function ensureModelSchema(sql: SqlHandle): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS model_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key_enc TEXT NOT NULL DEFAULT '',
    models_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS model_default (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    provider TEXT NOT NULL,
    model TEXT NOT NULL
  )`);
}

export function listProviderRows(sql: SqlHandle): ModelProviderRow[] {
  return sql.exec<ModelProviderRow>(
    "SELECT id, name, base_url, api_key_enc, models_json, created_at, updated_at FROM model_providers ORDER BY created_at ASC"
  ).results;
}

export function getProviderRow(sql: SqlHandle, id: string): ModelProviderRow | null {
  return (
    sql.exec<ModelProviderRow>(
      "SELECT id, name, base_url, api_key_enc, models_json, created_at, updated_at FROM model_providers WHERE id = ?",
      id
    ).results[0] ?? null
  );
}

export function upsertProviderRow(sql: SqlHandle, row: ModelProviderRow): void {
  sql.exec(
    `INSERT INTO model_providers
      (id, name, base_url, api_key_enc, models_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       base_url = excluded.base_url,
       api_key_enc = excluded.api_key_enc,
       models_json = excluded.models_json,
       updated_at = excluded.updated_at`,
    row.id,
    row.name,
    row.base_url,
    row.api_key_enc,
    row.models_json,
    row.created_at,
    row.updated_at
  );
}

export function deleteProviderRow(sql: SqlHandle, id: string): void {
  sql.exec("DELETE FROM model_providers WHERE id = ?", id);
  sql.exec("DELETE FROM model_default WHERE provider = ?", id);
}

export function readModelDefault(sql: SqlHandle): ModelDefault | null {
  const row = sql.exec<{ provider: string; model: string }>(
    "SELECT provider, model FROM model_default WHERE id = 1"
  ).results[0];
  return row ? { provider: row.provider, model: row.model } : null;
}

export function writeModelDefault(sql: SqlHandle, value: ModelDefault): void {
  sql.exec(
    "INSERT INTO model_default (id, provider, model) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, model = excluded.model",
    value.provider,
    value.model
  );
}
