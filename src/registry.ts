// The registry Durable Object: one instance (env.REGISTRY.idFromName("registry"))
// that owns the session index the console sidebar lists. It is pure bookkeeping
// over src/registry-store.ts; it never calls a model and never reads a transcript.
//
// This file is Worker-side: it value-imports `agents`, which pulls in
// `cloudflare:workers`, so no offline Node test can import it (the plan's D6
// limit, restated in progress.md R47). Its offline surface is
// tests/types.test.mjs, which reads the two statements named below out of this
// file and executes them against a real sqlite database.

import { Agent } from "agents";
import type { Env } from "./types";
import type { SqlHandle } from "./memory";
import {
  PLACEHOLDER_TITLE,
  deleteSession,
  ensureRegistrySchema,
  getSession,
  listSessions,
  renameSession,
  touchSession,
  upsertSession,
  type SessionRow,
} from "./registry-store";

/**
 * Boot seed for the conversation that already exists.
 *
 * R55: a DIRECT statement with ON CONFLICT(id) DO NOTHING, never upsertSession.
 * upsertSession is a whole-row replace, so running it at boot would reset a
 * title the user renamed. Without this seed the registry-backed sidebar opens
 * empty and every conversation that already exists disappears from the list
 * (R43). The store's schema leaves workspace_ref NULL and defaults unread and
 * pinned to 0, which is exactly what a legacy session has today.
 */
const MAIN_SEED_STATEMENT =
  "INSERT INTO sessions (id, title, created_at, updated_at, pinned, unread) VALUES (?, ?, ?, ?, 0, 0) ON CONFLICT(id) DO NOTHING";

/**
 * Task 5 shipped `sessions_updated_at ON sessions (updated_at)`, which cannot
 * serve the sidebar's only query, `ORDER BY pinned DESC, updated_at DESC`
 * (R59, the deferred finding: that index leaves sqlite sorting into a temp
 * b-tree). The matching composite index belongs in the schema, but Task 5's
 * landed test pins ensureRegistrySchema at exactly two exec calls, so the
 * smallest honest way to add it is here, in the same idempotent DDL style, and
 * it is stated in the task report for the reviewer to judge.
 */
const PINNED_ORDER_INDEX_STATEMENT =
  "CREATE INDEX IF NOT EXISTS sessions_pinned_updated ON sessions (pinned DESC, updated_at DESC)";

/** The legacy session id, which is also the legacy DO name (R38: ids are bare). */
const LEGACY_SESSION_ID = "main";

/** Default and ceiling for the HTTP list, matching the route contract in Task 7. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Length-check then constant-time string compare (no early exit on mismatch). */
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * True only when a non-empty AGENT_API_KEY is configured AND the request's
 * bearer token matches it. Fails CLOSED, the same rule as src/index.ts.
 *
 * Duplicated deliberately: Task 7 extracts this pair into src/auth.ts, which
 * does not exist yet, and a DO must not depend on the worker having checked for
 * it. When src/auth.ts lands, import from there instead of keeping two copies.
 */
function authed(request: Request, env: Env): boolean {
  const key = (env.AGENT_API_KEY ?? "").trim();
  if (!key) return false;
  const got = (request.headers.get("Authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  return safeEq(got, key);
}

/** Every id this DO reads comes from a URL segment; the value is always bound. */
function idFromSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

function limitFrom(search: URLSearchParams): number {
  const raw = Number(search.get("limit"));
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(raw), MAX_LIMIT);
}

/**
 * A request body read as JSON, or null when it is not JSON. Nothing here trusts
 * the shape: a row missing a required column is rejected, not coerced.
 *
 * Session ids are treated as opaque strings. The one copy of the id rule is
 * `isSessionId()` in src/session-scope.ts (R38), which Task 8 creates; this DO
 * must not restate that regex.
 */
function rowFrom(body: unknown): SessionRow | null {
  if (typeof body !== "object" || body === null) return null;
  const row = body as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0) return null;
  if (typeof row.title !== "string" || row.title.length === 0) return null;
  const created_at = wholeNumber(row.created_at);
  const updated_at = wholeNumber(row.updated_at);
  if (created_at === null || updated_at === null) return null;
  return {
    id: row.id,
    title: row.title,
    created_at,
    updated_at,
    workspace_ref: typeof row.workspace_ref === "string" ? row.workspace_ref : null,
    unread: wholeNumber(row.unread) ?? 0,
    pinned: wholeNumber(row.pinned) ?? 0,
  };
}

/** A JSON number, or null for anything else. Untrusted columns get rejected, not guessed at. */
function wholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const JSON_HEADERS = { "content-type": "application/json" };

function fail(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: JSON_HEADERS });
}

export class RegistryAgent extends Agent<Env> {
  private schemaReady = false;

  /**
   * Adapt the Agents SDK's tagged-template this.sql(strings, ...values) into
   * the exec-style SqlHandle src/registry-store.ts takes. Copied from the `db()`
   * adapter in src/agent.ts: the SDK rebuilds the query by joining the string
   * chunks with "?" for each value, so an exec-style query must be split on its
   * existing placeholders first, and a mismatch throws instead of misbinding.
   *
   * A reply carries `results` and nothing else, because the platform's cursor
   * exposes no per-statement affected-row count (R37, R58).
   */
  private db(): SqlHandle {
    const sqlTag = this.sql.bind(this) as unknown as (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => unknown[];
    const handle: SqlHandle = {
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
    if (!this.schemaReady) {
      ensureRegistrySchema(handle);
      this.schemaReady = true;
    }
    return handle;
  }

  /**
   * Runs on every cold start. Seeds `main` so the existing conversation is
   * still listed, then never touches that row again: the DO NOTHING seed is a
   * no-op once the row exists, whatever the user renamed it to.
   */
  async onStart(): Promise<void> {
    const sql = this.db();
    ensureRegistrySchema(sql);
    sql.exec(PINNED_ORDER_INDEX_STATEMENT);
    const now = Date.now();
    sql.exec(MAIN_SEED_STATEMENT, LEGACY_SESSION_ID, PLACEHOLDER_TITLE, now, now);
  }

  // ---- RPC surface (what src/routes.ts calls over the stub) ----

  /** Newest first, pinned rows ahead. The limit passes through as the caller set it. */
  async list(limit: number): Promise<SessionRow[]> {
    return listSessions(this.db(), limit);
  }

  /** Whole-row write: the caller owns every column it sends, created_at included. */
  async put(row: SessionRow): Promise<void> {
    upsertSession(this.db(), row);
  }

  /** Title only; a rename deliberately does not bump updated_at. Returns void (R37, R58). */
  async rename(id: string, title: string): Promise<void> {
    renameSession(this.db(), id, title);
  }

  /** Returns void, never a "was it there" boolean (R37, R58). */
  async remove(id: string): Promise<void> {
    deleteSession(this.db(), id);
  }

  /** Bump updated_at to now, plus unread when opts carries an unreadDelta. */
  async touch(id: string, opts?: { unreadDelta?: number }): Promise<void> {
    touchSession(this.db(), id, Date.now(), opts);
  }

  /**
   * HTTP surface for the worker proxy, under /registry/... only.
   *
   *   GET    /registry/sessions?limit=N    { ok, sessions }
   *   POST   /registry/sessions            put(row)        -> { ok, session }
   *   PATCH  /registry/sessions/:id        rename(id,t)    -> { ok }
   *   DELETE /registry/sessions/:id        remove(id)      -> { ok }
   *   POST   /registry/sessions/:id/touch  touch(id,opts)  -> { ok }
   *
   * Anything outside the prefix falls through to super.fetch, NOT a 404:
   * overriding fetch on an Agent subclass replaces the SDK's own entry point,
   * which routes through this.lifecycle.fetch and serves RPC and the WebSocket
   * surface, so a hard stop here would shadow every SDK HTTP surface on the DO.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/registry/")) {
      return super.fetch(request);
    }
    if (!authed(request, this.env)) {
      return fail(401, "unauthorized");
    }

    const route = url.pathname.replace(/^\/registry\//, "");
    const segments = route.split("/");

    if (segments[0] === "sessions" && segments.length === 1) {
      if (request.method === "GET") {
        const sessions = await this.list(limitFrom(url.searchParams));
        return new Response(JSON.stringify({ ok: true, sessions }), { headers: JSON_HEADERS });
      }
      if (request.method === "POST") {
        const row = rowFrom(await readJson(request));
        if (!row) return fail(400, "a full session row is required");
        await this.put(row);
        return new Response(JSON.stringify({ ok: true, session: row }), { headers: JSON_HEADERS });
      }
      return fail(405, "method not allowed");
    }

    if (segments[0] === "sessions" && (segments.length === 2 || segments.length === 3)) {
      const id = idFromSegment(segments[1]);
      if (!id) return fail(400, "session id required");
      const sub = segments[2];

      if (sub === undefined) {
        if (request.method === "PATCH") {
          const body = (await readJson(request)) as { title?: unknown } | null;
          const title = typeof body?.title === "string" ? body.title.trim() : "";
          if (!title) return fail(400, "title required");
          await this.rename(id, title);
          return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
        }
        if (request.method === "DELETE") {
          await this.remove(id);
          return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
        }
        if (request.method === "GET") {
          // Read-back over HTTP so a client can confirm a write landed; the RPC
          // surface has no get because Task 7's routes list instead.
          const session = getSession(this.db(), id);
          if (!session) return fail(404, "not found");
          return new Response(JSON.stringify({ ok: true, session }), { headers: JSON_HEADERS });
        }
        return fail(405, "method not allowed");
      }

      if (sub === "touch" && segments.length === 3 && request.method === "POST") {
        const body = (await readJson(request)) as { unreadDelta?: unknown } | null;
        if (body === null) return fail(400, "invalid JSON body");
        // An absent key and an explicit null both mean "no delta"; the store
        // reads undefined that way. Any other value must be a whole number.
        const delta = body.unreadDelta === null ? undefined : body.unreadDelta;
        if (delta !== undefined && !(typeof delta === "number" && Number.isInteger(delta))) {
          return fail(400, "unreadDelta must be an integer when present");
        }
        await this.touch(id, { unreadDelta: delta as number | undefined });
        return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
      }
    }

    return fail(404, "not found");
  }
}

/** Parsed JSON body, or null when the body is absent or malformed. */
async function readJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
