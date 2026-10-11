// State vault: chunked blob storage in the agent DO's SQLite.
// Used by the 9router container to persist data.sqlite across deploys/updates.
// Row limit on DO SQLite is 2MB, so blobs are stored as base64 chunks < 1.4MB
// raw (~1.87MB base64) under a composite (key, idx) primary key.

import type { SqlHandle } from "./memory";

export const MAX_CHUNK_BYTES = 1_400_000;

export function ensureVaultSchema(sql: SqlHandle): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS vault_chunks (
    vault_key TEXT NOT NULL,
    idx INTEGER NOT NULL,
    total INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (vault_key, idx)
  )`);
}

export interface VaultMeta {
  key: string;
  total: number;
  bytes: number;
  updated_at: number;
}

export function vaultMeta(sql: SqlHandle, key: string): VaultMeta | null {
  const rows = sql.exec<{ cnt: number; total: number; bytes: number; updated_at: number }>(
    "SELECT COUNT(*) AS cnt, MAX(total) AS total, COALESCE(SUM(LENGTH(data)), 0) AS bytes, MAX(updated_at) AS updated_at FROM vault_chunks WHERE vault_key = ?",
    key
  ).results;
  const r = rows[0];
  if (!r || r.cnt === 0) return null;
  return {
    key,
    total: r.total ?? 0,
    // approximate raw bytes from stored base64 length
    bytes: Math.floor((r.bytes ?? 0) * 0.75),
    updated_at: r.updated_at ?? 0,
  };
}

export function vaultPutChunk(
  sql: SqlHandle,
  key: string,
  idx: number,
  total: number,
  dataB64: string
): void {
  sql.exec(
    "INSERT OR REPLACE INTO vault_chunks (vault_key, idx, total, data, updated_at) VALUES (?, ?, ?, ?, ?)",
    key,
    idx,
    total,
    dataB64,
    Date.now()
  );
}

export function vaultGetBytes(sql: SqlHandle, key: string): Uint8Array | null {
  const rows = sql.exec<{ data: string }>(
    "SELECT data FROM vault_chunks WHERE vault_key = ? ORDER BY idx ASC",
    key
  ).results;
  if (rows.length === 0) return null;
  // Chunks are independently base64-encoded (each carries its own padding),
  // so decode per chunk; one joined decode would stop at the first '='.
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const r of rows) {
    const bin = atob(r.data);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    parts.push(u);
    total += u.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function vaultDelete(sql: SqlHandle, key: string): void {
  sql.exec("DELETE FROM vault_chunks WHERE vault_key = ?", key);
}

export function splitB64Chunks(bytes: Uint8Array): string[] {
  const chunks: string[] = [];
  for (let off = 0; off < bytes.length; off += MAX_CHUNK_BYTES) {
    const slice = bytes.subarray(off, Math.min(off + MAX_CHUNK_BYTES, bytes.length));
    let bin = "";
    // btoa wants a binary string; build in slices to avoid arg limits
    const STEP = 0x8000;
    for (let i = 0; i < slice.length; i += STEP) {
      bin += String.fromCharCode(...slice.subarray(i, i + STEP));
    }
    chunks.push(btoa(bin));
  }
  return chunks;
}
