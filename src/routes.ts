// Worker-side HTTP for the `/api/sessions*` family (plan Task 7).
//
// WHY THIS FILE EXISTS AT ALL. src/index.ts value-imports ./agent, and src/agent.ts
// value-imports the Agents SDK, which pulls in `cloudflare:workers`; plain Node
// cannot resolve that, so no offline test can ever import src/index.ts. These routes
// are the part of the worker a test CAN drive, which means this module imports types
// plus dependency-free modules only (R39), and takes both DO namespaces from the
// `env` argument instead of the classes they are bound to.
//
// WHAT IT OWNS (R42): the six routes below and nothing else. `/api/message`,
// `/api/tasks`, `/api/approve`, `/api/decide`, the WebSocket upgrade and the six
// `/internal/vault/*` handlers keep their existing addressing in src/index.ts;
// src/index.ts delegates here on the `/api/sessions` prefix only. `/api/plan` is
// removed by Task 15, not by this file.
//
//   GET    /api/sessions?limit=N          { ok, sessions: SessionRow[], truncated }
//   POST   /api/sessions                  { ok, session: SessionRow }
//   PATCH  /api/sessions/:id              { ok }
//   DELETE /api/sessions/:id              { ok }
//   GET    /api/sessions/:id/messages     { ok, messages: MessageRow[] }  (oldest first)
//   POST   /api/sessions/:id/message      the agent's AgentReply, unmodified
//
// Every one of them 401s when `authed()` fails and 400s on a malformed body. A shape
// the family does not serve, including a wrong method on a shape it does, is 404.
//
// THE GATE ORDER for a session-addressed request (R76), and what each answer means:
//
//   1. auth                     401
//   2. isSessionId(id)          400, BEFORE any idFromName call
//   3. registry.exists(id)      404 on a well-formed id with no row, BEFORE the DO
//   4. the DO                   200, or 403 for a reply carrying code "invalid_session"
//
// Step 2 is where an attacker-controlled string is actually stopped, and it covers
// `messages` as well as `chat`: the rule has ONE copy, `isSessionId()` in
// src/session-scope.ts (R38), which this module is allowed to value-import (R75)
// precisely because that module imports nothing at all (R47). Step 3 exists because
// the shape rule stops hostile shapes and nothing else: any 26-hex name is
// well-formed, and a send to one no one created would instantiate a DO whose
// transcript never appears in `GET /api/sessions`, because `touchSession` is an
// UPDATE that affects zero rows for an unknown id (R73 amendment 4). A DO name is an
// opaque string the platform hashes to an id, so traversal has no meaning at that
// layer and never did; the risk here is orphan state, not path escape.
//
// TRAVERSAL IS NOT WHAT STEP 2 STOPS, because the URL layer gets there first. A path
// whose NORMALIZED form leaves the prefix never reaches any of this: the prefix test
// fails and src/index.ts answers the 404. That includes the percent-encoded double
// dot, because WHATWG path normalization counts a whole `%2e%2e` segment as a double
// dot (measured: `/api/sessions/%2e%2e/message` is `/api/message` before this module
// sees it, upper- or lowercase alike). What step 2 does stop is the segment that
// SURVIVES normalization and only turns hostile when decoded, because `idFromSegment`
// runs `decodeURIComponent` after the URL layer is finished: `abc%2fdef` reads as
// `abc/def`, `a%20b` as `a b`, `abc%2e%2edef` as `abc..def`, `..%2f..%2fetc` as
// `../../etc`, and a double-encoded `%252e%252e` as a literal `%2e%2e`. Those are the
// shapes that would otherwise reach `idFromName` and let a client steer which DO id it
// names.

// The four value imports below carry their `.ts` extension, because plain Node
// (which runs tests/routes.test.mjs, and nothing else can) is a strict ESM resolver:
// an extensionless relative specifier never reaches `auth.ts`. Type imports are erased
// before resolution, so they stay extensionless like the rest of the repo.
//
// `allowImportingTsExtensions` is on in this tsconfig, legal because `noEmit` is
// already true, so a `.ts` specifier is permitted rather than suppressed: tsc type
// checks these four lines normally. Wrangler's esbuild resolves both spellings.
// These four are the whole value-import set because R39 lets this module reach only
// `src/*.ts` files that are themselves dependency-free under plain Node, which is
// exactly why ./session-scope joined ./auth, ./registry-input and ./registry-store in
// Task 8 (R75); a fifth value import has to clear that rule first.
import { idFromSegment, limitFrom, readJson } from "./registry-input.ts";
import { PLACEHOLDER_TITLE } from "./registry-store.ts";
import { isSessionId } from "./session-scope.ts";
import { authed } from "./auth.ts";
import type { MessageRow } from "./memory";
import type { SessionRow } from "./registry-store";
import type { AgentReply, AgentStub, ChatTier, Env, RegistryStub } from "./types";

/** The one path prefix this module answers for. */
const SESSIONS_PATH = "/api/sessions";

/** The registry is a single instance, addressed by this fixed name (Task 6). */
const REGISTRY_NAME = "registry";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function fail(status: number, error: string): Response {
  return Response.json({ ok: false, error }, { status });
}

/**
 * A session id is 26 hex characters, the length a Cloudflare DO name is addressed
 * with, taken from a UUIDv4 with the dashes removed.
 */
function newSessionId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 26);
}

/**
 * The stub for one session's Durable Object (R38): the session id IS the DO name,
 * with no prefix, so the legacy `idFromName("main")` stays reachable as session
 * `main` and keeps every existing memory, task and vault chunk alive.
 */
export function agentStubFor(env: Env, sessionId: string): AgentStub {
  const stub = env.FEDERATION_AGENT.get(env.FEDERATION_AGENT.idFromName(sessionId));
  // Cast avoids depending on version-specific DurableObjectNamespace generics.
  return stub as unknown as AgentStub;
}

function registryStubFor(env: Env): RegistryStub {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(REGISTRY_NAME));
  return stub as unknown as RegistryStub;
}

/**
 * A create carries no fields: this route owns every column of the row it writes.
 * `title TEXT NOT NULL` and both timestamps have no other filler anywhere in the
 * plan, so an absent body is fine and only a present-but-unparseable one is a
 * malformed request.
 */
async function createSession(request: Request, env: Env): Promise<Response> {
  const raw = await request.text();
  if (raw.trim() !== "") {
    try {
      JSON.parse(raw);
    } catch {
      return fail(400, "invalid JSON body");
    }
  }
  const now = Date.now();
  const row: SessionRow = {
    id: newSessionId(),
    title: PLACEHOLDER_TITLE,
    created_at: now,
    updated_at: now,
    workspace_ref: null,
    unread: 0,
    pinned: 0,
  };
  await registryStubFor(env).put(row);
  return json({ ok: true, session: row });
}

/** Title only. A rename deliberately does NOT bump updated_at (R37). */
async function renameSession(request: Request, env: Env, id: string): Promise<Response> {
  const body = (await readJson(request)) as { title?: unknown } | null;
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) return fail(400, "title required");
  await registryStubFor(env).rename(id, title);
  return json({ ok: true });
}

/**
 * The transcript of one session, read from that session's own DO and never from
 * main (R41). The rows are `recentMessages`' own output, unmodified and in its own
 * order: OLDEST FIRST, so the newest turn is the LAST element (src/memory.ts:143-149
 * reverses a DESC select). The console day-groups this list, and a later task that
 * assumed newest-first would silently reverse the transcript, so the order is stated
 * here and in src/types.ts rather than re-imposed (R71 amendment 3). They are
 * MessageRows (id, role, content, tier, created_at), not UIMessages, and nothing here
 * drops created_at on the way to the console.
 *
 * The limit is the list route's own `limitFrom`, not a second clamp: this uses the
 * registry's numbers rather than restating them, so a sidebar page and a transcript
 * page cannot disagree about what "the last N" means, and DEFAULT_LIMIT/MAX_LIMIT
 * come from ./registry-input, which is dependency-free and therefore legal to
 * value-import here.
 *
 * The caller has already cleared both gates (shape, then registry `exists`), so no
 * id reaching this line can instantiate a DO for a session nobody created.
 */
async function readTranscript(env: Env, id: string, search: URLSearchParams): Promise<Response> {
  const messages: MessageRow[] = await agentStubFor(env, id).messages(limitFrom(search));
  return json({ ok: true, messages });
}

/**
 * Submit and return (R41). The session id travels in the DO this addresses AND, since
 * Task 8, in `chat`'s third argument, so the DO can verify the claim (R39): the id is
 * LAST and optional, which is what lets src/index.ts's unscoped `/api/message` keep
 * compiling until Task 22 removes it. An absent or unrecognised tier is `undefined`,
 * the same rule src/index.ts applies to /api/message.
 *
 * A reply carrying `code: "invalid_session"` is a DO that refused work outside its own
 * session (Task 8) and answers 403. It is NOT activity, so the registry `touch` is
 * skipped: a request the DO refused must not reorder or re-date the session list
 * (R71 amendment 2). Any other reply, including one carrying a different code, is a
 * real answer and bumps updated_at and nothing else, because the list is
 * `ORDER BY pinned DESC, updated_at DESC` (R54) and a route that only returned the
 * reply would leave the session being typed in where it was. `touch` with no opts:
 * unread is a later phase, since the person sending is reading that session (Task 33).
 *
 * The touch goes through `ctx.waitUntil`, not an `await` (R71 amendment 5): the reply
 * is already paid for, and an `await` here would let a rejecting registry RPC escape
 * `handleFetch` and cost the caller an answer the model already produced. The reply
 * is durable either way, because the platform runs the promised work to completion.
 */
async function sendMessage(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string
): Promise<Response> {
  const body = (await readJson(request)) as { content?: unknown; tier?: unknown } | null;
  if (typeof body?.content !== "string" || body.content.length === 0) {
    return fail(400, "content required");
  }
  const tier: ChatTier | undefined =
    body.tier === "primary" || body.tier === "cheap" ? body.tier : undefined;
  const reply: AgentReply = await agentStubFor(env, id).chat(body.content, tier, id);
  if (reply.code === "invalid_session") {
    return fail(403, "invalid session");
  }
  ctx.waitUntil(registryStubFor(env).touch(id));
  return json(reply);
}

function isSessionsPath(pathname: string): boolean {
  return pathname === SESSIONS_PATH || pathname.startsWith(`${SESSIONS_PATH}/`);
}

/**
 * The whole `/api/sessions*` family. src/index.ts calls this for that prefix and
 * nothing else; anything outside it is a 404 rather than a silent fall-through, so a
 * typo here can never reach a handler this file does not own.
 *
 * `ctx` carries the background work these routes promise (Task 8: the accepted
 * send's registry `touch`; Task 22: the stream proxy) so a rejecting RPC cannot
 * cost a reply the model already produced.
 */
export async function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  if (!isSessionsPath(url.pathname)) return fail(404, "not found");
  if (!authed(request, env)) return fail(401, "unauthorized");

  const parts = url.pathname
    .slice(SESSIONS_PATH.length)
    .split("/")
    .filter((segment) => segment !== "");

  // GET /api/sessions  |  POST /api/sessions
  if (parts.length === 0) {
    if (request.method === "GET") {
      const limit = limitFrom(url.searchParams);
      const sessions: SessionRow[] = await registryStubFor(env).list(limit);
      // The store was asked for `limit` rows and returned exactly that many, so
      // there is very likely more behind it.
      return json({ ok: true, sessions, truncated: sessions.length === limit });
    }
    if (request.method === "POST") return createSession(request, env);
    return fail(404, "not found");
  }

  const id = idFromSegment(parts[0]);
  if (!id) return fail(404, "not found");
  // Gate 2 (R76): EVERY `:id` is shape-checked here, before any `idFromName` call and
  // before any handler that could reach a session DO. One copy of the rule, R38. The
  // shapes dying here are the ones `decodeURIComponent` turns hostile after the URL
  // layer is done (`abc%2fdef`, `a%20b`, `abc%2e%2edef`); a whole `%2e%2e` segment
  // never gets this far, because path normalization pops it out of the prefix first.
  if (!isSessionId(id)) return fail(400, "invalid session id");

  // PATCH /api/sessions/:id  |  DELETE /api/sessions/:id
  if (parts.length === 1) {
    if (request.method === "PATCH") return renameSession(request, env, id);
    if (request.method === "DELETE") {
      await registryStubFor(env).remove(id);
      return json({ ok: true });
    }
    return fail(404, "not found");
  }

  // GET /api/sessions/:id/messages  |  POST /api/sessions/:id/message
  if (parts.length === 2) {
    const sub = parts[1];
    if (sub === "messages" && request.method === "GET") {
      // Gate 3 (R76): a well-formed id with no registry row is answered here, with no
      // DO addressed at all. `idFromName` cannot report absence (a DO name is an
      // opaque string hashed to an id), so without this read any 26-hex name would
      // instantiate a DO and file its transcript where `GET /api/sessions` never
      // lists it, because `touchSession` updates zero rows for an unknown id (R73).
      if (!(await registryStubFor(env).exists(id))) return fail(404, "not found");
      return readTranscript(env, id, url.searchParams);
    }
    if (sub === "message" && request.method === "POST") {
      if (!(await registryStubFor(env).exists(id))) return fail(404, "not found");
      return sendMessage(request, env, ctx, id);
    }
    return fail(404, "not found");
  }

  return fail(404, "not found");
}
