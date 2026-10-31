// Google accounts and OAuth states over SqlHandle. Pure storage: no SDK, no
// network, and no encryption. The caller encrypts refresh tokens before passing
// refresh_enc here and must use publicAccount() for anything browser-facing.

import type {
  GoogleAccountRow,
  GoogleAccountStatus,
  GoogleAccountView,
  GoogleOAuthStateRow,
} from "./google-types.ts";
import type { SqlHandle } from "./memory.ts";

const ACCOUNT_COLUMNS = `id, google_sub, email, name, picture, refresh_enc, scopes,
  is_default, status, last_error, last_refresh_at, created_at, updated_at`;

function firstRow<T>(
  sql: SqlHandle,
  query: string,
  ...bindings: Array<string | number | null>
): T | null {
  return sql.exec<T>(query, ...bindings).results[0] ?? null;
}

function accountBySub(sql: SqlHandle, sub: string): GoogleAccountRow | null {
  return firstRow<GoogleAccountRow>(
    sql,
    `SELECT ${ACCOUNT_COLUMNS} FROM google_accounts WHERE google_sub = ? LIMIT 1`,
    sub
  );
}

function accountByEmail(sql: SqlHandle, email: string): GoogleAccountRow | null {
  return firstRow<GoogleAccountRow>(
    sql,
    `SELECT ${ACCOUNT_COLUMNS} FROM google_accounts
     WHERE email = ? COLLATE NOCASE LIMIT 1`,
    email.trim()
  );
}

/** Accepts an account id or email; surrounding whitespace is never an identity. */
export function normalizeAccountTarget(account: string): string {
  return typeof account === "string" ? account.trim() : "";
}

/** Stored scopes are JSON arrays; tolerate older space-separated rows. */
function scopeList(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item): item is string => typeof item === "string" && item.trim() !== ""
      );
    }
    if (typeof parsed === "string") {
      return parsed.split(/\s+/).filter(Boolean);
    }
  } catch {
    // Not JSON: fall through to the space-separated form.
  }
  return raw.split(/\s+/).filter(Boolean);
}

/** Browser-safe projection: strips refresh_enc and google_sub, decodes flags. */
export function publicAccount(row: GoogleAccountRow): GoogleAccountView {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    picture: row.picture,
    is_default: Number(row.is_default) === 1,
    status: row.status,
    scopes: scopeList(row.scopes),
    last_error: row.last_error,
    last_refresh_at: row.last_refresh_at,
    created_at: row.created_at,
  };
}

/** One-call schema helper for runtime setup code. */
export function ensureGoogleSchema(sql: SqlHandle): void {
  new GoogleStore(sql).ensureSchema();
}

export class GoogleStore {
  sql: SqlHandle;

  constructor(sql: SqlHandle) {
    this.sql = sql;
  }

  /** Idempotent schema; both identities are unique so reconnects cannot fork. */
  ensureSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS google_accounts (
      id TEXT PRIMARY KEY,
      google_sub TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      name TEXT,
      picture TEXT,
      refresh_enc TEXT NOT NULL,
      scopes TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      last_error TEXT,
      last_refresh_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS google_oauth_states (
      state TEXT PRIMARY KEY,
      redirect_uri TEXT NOT NULL,
      login_hint TEXT,
      created_at INTEGER NOT NULL
    )`);
  }

  createState(state: GoogleOAuthStateRow): void {
    this.sql.exec(
      `INSERT INTO google_oauth_states (state, redirect_uri, login_hint, created_at)
       VALUES (?, ?, ?, ?)`,
      state.state,
      state.redirect_uri,
      state.login_hint,
      state.created_at
    );
  }

  /**
   * Read-and-delete in one synchronous turn. DO input gates serialize access,
   * so a replay observes a missing row. Expired states are deleted too.
   */
  consumeState(state: string, now: number, maxAgeMs: number): GoogleOAuthStateRow | null {
    const row = firstRow<GoogleOAuthStateRow>(
      this.sql,
      `SELECT state, redirect_uri, login_hint, created_at
       FROM google_oauth_states WHERE state = ?`,
      state
    );
    if (!row) return null;
    this.sql.exec("DELETE FROM google_oauth_states WHERE state = ?", state);
    const age = now - Number(row.created_at);
    if (!Number.isFinite(age) || age > maxAgeMs) return null;
    return row;
  }

  pruneStates(now: number, maxAgeMs: number): void {
    this.sql.exec(
      "DELETE FROM google_oauth_states WHERE created_at < ?",
      now - maxAgeMs
    );
  }

  /**
   * Insert, or refresh an existing account matched by its stable Google sub.
   * An email-only match is accepted only when the caller reuses that row's id
   * (the registry's reconnect path); a new identity cannot take over an email.
   * A successful authorization clears reauth_required and last_error.
   */
  upsertAccount(row: GoogleAccountRow): GoogleAccountRow {
    const bySub = accountBySub(this.sql, row.google_sub);
    const byEmail = bySub ? null : accountByEmail(this.sql, row.email);
    const existing = bySub ?? (byEmail?.id === row.id ? byEmail : null);
    if (existing) {
      this.sql.exec(
        `UPDATE google_accounts SET
           google_sub = ?, email = ?, name = ?, picture = ?,
           refresh_enc = ?, scopes = ?, status = 'active', last_error = NULL,
           last_refresh_at = ?, updated_at = ?
         WHERE id = ?`,
        row.google_sub,
        row.email,
        row.name,
        row.picture,
        row.refresh_enc,
        row.scopes,
        row.last_refresh_at ?? existing.last_refresh_at,
        row.updated_at,
        existing.id
      );
      const updated = this.getAccount(existing.id);
      if (!updated) throw new Error("Google account update did not return a row");
      return updated;
    }

    if (byEmail) {
      throw new Error(
        "this Google email is already connected to a different Google account"
      );
    }

    const count = this.sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM google_accounts"
    ).results[0];
    const isDefault = Number(count?.n ?? 0) === 0 ? 1 : 0;
    this.sql.exec(
      `INSERT INTO google_accounts (
         id, google_sub, email, name, picture, refresh_enc, scopes, is_default,
         status, last_error, last_refresh_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.google_sub,
      row.email,
      row.name,
      row.picture,
      row.refresh_enc,
      row.scopes,
      isDefault,
      row.status,
      row.last_error,
      row.last_refresh_at,
      row.created_at,
      row.updated_at
    );
    const inserted = this.getAccount(row.id);
    if (!inserted) throw new Error("Google account insert did not return a row");
    return inserted;
  }

  /** Default first, then oldest, so prompt and pickers are stable. */
  listAccounts(): GoogleAccountRow[] {
    return this.sql.exec<GoogleAccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM google_accounts
       ORDER BY is_default DESC, created_at ASC, id ASC`
    ).results;
  }

  getAccount(id: string): GoogleAccountRow | null {
    return firstRow<GoogleAccountRow>(
      this.sql,
      `SELECT ${ACCOUNT_COLUMNS} FROM google_accounts WHERE id = ?`,
      id
    );
  }

  /** Instance form for runtime callers; the module export stays available. */
  publicAccount(row: GoogleAccountRow): GoogleAccountView {
    return publicAccount(row);
  }

  /** Resolve a user-supplied id or email (case-insensitive for email). */
  resolveAccount(target: string): GoogleAccountRow | null {
    const value = normalizeAccountTarget(target);
    if (!value) return null;
    const byId = this.getAccount(value);
    if (byId) return byId;
    return accountByEmail(this.sql, value);
  }

  /**
   * Clear every default flag and set exactly one. A missing id leaves the
   * previous default untouched. Both updates run in the same DO turn.
   */
  setDefault(id: string): boolean {
    if (!this.getAccount(id)) return false;
    this.sql.exec("UPDATE google_accounts SET is_default = 0 WHERE is_default <> 0");
    this.sql.exec(
      "UPDATE google_accounts SET is_default = 1, updated_at = ? WHERE id = ?",
      Date.now(),
      id
    );
    return true;
  }

  /**
   * Delete one account. If that leaves no default, promote the oldest
   * remaining account; removing the last account simply leaves none.
   */
  deleteAccount(id: string): boolean {
    const row = this.getAccount(id);
    if (!row) return false;
    this.sql.exec("DELETE FROM google_accounts WHERE id = ?", id);

    const stillDefault = firstRow<{ id: string }>(
      this.sql,
      "SELECT id FROM google_accounts WHERE is_default = 1 LIMIT 1"
    );
    if (!stillDefault) {
      const oldest = firstRow<{ id: string }>(
        this.sql,
        `SELECT id FROM google_accounts
         WHERE is_default = 0 ORDER BY created_at ASC, id ASC LIMIT 1`
      );
      if (oldest) {
        this.sql.exec(
          "UPDATE google_accounts SET is_default = 1, updated_at = ? WHERE id = ?",
          Date.now(),
          oldest.id
        );
      }
    }
    return true;
  }

  markStatus(
    id: string,
    status: GoogleAccountStatus,
    error: string | null,
    now: number
  ): void {
    this.sql.exec(
      "UPDATE google_accounts SET status = ?, last_error = ?, updated_at = ? WHERE id = ?",
      status,
      error,
      now,
      id
    );
  }

  /**
   * Store a rotated refresh token and scopes after a successful refresh.
   * last_refresh_at only advances on success, matching the design.
   */
  updateRefresh(
    id: string,
    refreshEnc: string,
    scopes: string,
    now: number
  ): void {
    this.sql.exec(
      `UPDATE google_accounts SET
         refresh_enc = ?, scopes = ?, status = 'active', last_error = NULL,
         last_refresh_at = ?, updated_at = ?
       WHERE id = ?`,
      refreshEnc,
      scopes,
      now,
      now,
      id
    );
  }
}
