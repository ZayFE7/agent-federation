// The registry Durable Object: one instance (env.REGISTRY.idFromName("registry"))
// that owns the session index the console sidebar lists. It is pure bookkeeping
// over src/registry-store.ts; it never calls a model and never reads a transcript.
//
// This file is Worker-side: it value-imports `agents`, which pulls in
// `cloudflare:workers`, so no offline Node test can import it (the plan's D6
// limit, restated in progress.md R47). What it delegates to IS executed offline:
// the input parsing lives in src/registry-input.ts (tests/registry-input.test.mjs)
// and the SQL adapter in src/sql-handle.ts (tests/sql-handle.test.mjs).
// tests/registry.test.mjs reads this file as text and runs the seed statement
// named below against a real sqlite database.

import { Agent } from "agents";
import type { Env } from "./types";
import type { SqlHandle } from "./memory";
import { toSqlHandle, type SqlTag } from "./sql-handle";
import {
  MAX_LIMIT,
  idFromSegment,
  limitFrom,
  readJson,
  rowFrom,
} from "./registry-input";
import {
  PLACEHOLDER_TITLE,
  deleteSession,
  ensureRegistrySchema,
  getSession,
  listSessions,
  readRegistryMeta,
  renameSession,
  touchSession,
  upsertSession,
  writeRegistryMeta,
  type SessionRow,
} from "./registry-store";
import { MAIN_DO_NAME } from "./session-scope";

/**
 * Boot seed for the conversation that already exists.
 *
 * R55: a DIRECT statement with ON CONFLICT(id) DO NOTHING, never upsertSession.
 * upsertSession is a whole-row replace, so running it at boot would reset a
 * title the user renamed. Without this seed the registry-backed sidebar opens
 * empty and every conversation that already exists disappears from the list
 * (R43). The store's schema leaves workspace_ref NULL and defaults unread and
 * pinned to 0, which is exactly what a legacy session has today.
 *
 * DO NOTHING protects an EXISTING row, not an absent one, so on its own this
 * would re-insert `main` after the user deletes it and the sidebar would show a
 * "New session" whose DO still holds the real transcript (R64 I1). That is why
 * onStart() reads a persisted registry_meta marker first: the seed runs once per
 * database, and the marker outlives the DO instance that wrote it.
 */
const MAIN_SEED_STATEMENT =
  "INSERT INTO sessions (id, title, created_at, updated_at, pinned, unread) VALUES (?, ?, ?, ?, 0, 0) ON CONFLICT(id) DO NOTHING";

/** The registry_meta key holding the timestamp of the one boot seed (R64 I1). */
const SEEDED_KEY = "main_seeded";

/** The legacy session id, which is also the legacy DO name (R38: ids are bare). */
const LEGACY_SESSION_ID = MAIN_DO_NAME;

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

const JSON_HEADERS = { "content-type": "application/json" };

function fail(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: JSON_HEADERS });
}

export class RegistryAgent extends Agent<Env> {
  private schemaReady = false;

  /**
   * Adapt the Agents SDK's tagged-template this.sql(strings, ...values) into
   * the exec-style SqlHandle src/registry-store.ts takes. The adapter itself is
   * src/sql-handle.ts, shared with the `db()` in src/agent.ts; this method owns
   * only the schema guard.
   *
   * A reply carries `results` and nothing else, because the platform's cursor
   * exposes no per-statement affected-row count (R37, R58).
   */
  private db(): SqlHandle {
    const handle = toSqlHandle(this.sql.bind(this) as unknown as SqlTag);
    if (!this.schemaReady) {
      // The store owns every piece of DDL: the sessions table, registry_meta and
      // the composite index the sidebar's only query needs (R54). Nothing here
      // creates schema, so this guard and onStart() cannot disagree about it.
      ensureRegistrySchema(handle);
      this.schemaReady = true;
    }
    return handle;
  }

  /**
   * Runs on every cold start, and seeds exactly once per database: the marker
   * read is what makes the second cold start after a delete of `main` a no-op
   * instead of a resurrection (R64 I1). Not this.setState: state saved here
   * would describe one instance, and a cold start is precisely what destroys it.
   *
   * Schema comes from `this.db()` and nothing else, so it is never created twice.
   */
  async onStart(): Promise<void> {
    const sql = this.db();
    if (readRegistryMeta(sql, SEEDED_KEY) !== null) return;
    const now = Date.now();
    sql.exec(MAIN_SEED_STATEMENT, LEGACY_SESSION_ID, PLACEHOLDER_TITLE, now, now);
    writeRegistryMeta(sql, SEEDED_KEY, String(Date.now()));
  }

  // ---- RPC surface (what src/routes.ts calls over the stub) ----

  /**
   * Newest first, pinned rows ahead. The limit is floored and capped here, so a
   * zero, a negative or a fraction can never reach SQLite as `LIMIT -1`, which
   * SQLite reads as unlimited.
   */
  async list(limit: number): Promise<SessionRow[]> {
    return listSessions(this.db(), Math.min(Math.max(1, Math.floor(limit)), MAX_LIMIT));
  }

  /**
   * One-row read for the worker's session routes (R74): is this id in the index?
   *
   * The routes must be able to refuse a well-formed id that no one created BEFORE
   * they address a session DO with it, because a DO name is an opaque string the
   * platform hashes to an id (R38): nothing about `idFromName` says "no such
   * session", so an uncreated id silently instantiates a DO, and its transcript
   * then lives in an instance that `GET /api/sessions` never lists (R73 amendment
   * 4). A DO name is not a path, so this is about orphan state and free DO
   * instantiation, never about traversal.
   *
   * `getSession` is the store's own one-row read, so no SQL is restated here, and
   * this is a real boolean rather than the affected-row count R58 forbids: it
   * reports a row, not a write.
   */
  async exists(id: string): Promise<boolean> {
    return getSession(this.db(), id) !== null;
  }

  /**
   * One-row read by id (Task 9): the title fiber's pre-rename check. It must
   * see the CURRENT title so a user rename that landed while the cheap model
   * was busy wins, and an absent row fails closed (no row, no rename). Not
   * `list(MAX_LIMIT)`: a row outside the 200 window would silently switch
   * title generation off for exactly the old sessions still saying
   * `New session`.
   *
   * `getSession` is the store's own one-row read, so no SQL is restated here.
   */
  async get(id: string): Promise<SessionRow | null> {
    return getSession(this.db(), id);
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
   *
   * A path this DO owns but cannot serve with the method used answers 405; 404
   * is reserved for a shape it does not recognise at all.
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

      if (sub === "touch" && segments.length === 3) {
        // /registry/sessions/:id/touch is this DO's own path, whatever the
        // method, so a wrong one is 405 rather than a fall-through to 404.
        if (request.method !== "POST") {
          return fail(405, "method not allowed");
        }
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
