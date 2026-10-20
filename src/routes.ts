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
//   GET    /api/sessions/:id/messages     { ok, messages: MessageRow[] }
//   POST   /api/sessions/:id/message      the agent's AgentReply, unmodified
//
// Every one of them 401s when `authed()` fails and 400s on a malformed body. A shape
// the family does not serve, including a wrong method on a shape it does, is 404.
//
// Session ids are NOT validated here: Task 8 creates src/session-scope.ts and wires
// the 400 for a bad id, in this file, before any idFromName call (R65). Validating a
// second time here would put two copies of the rule in the tree.

// The three value imports below carry their `.ts` extension, because plain Node
// (which runs tests/routes.test.mjs, and nothing else can) is a strict ESM resolver:
// an extensionless relative specifier never reaches `auth.ts`. Type imports are erased
// before resolution, so they stay extensionless like the rest of the repo.
//
// `allowImportingTsExtensions` is on in this tsconfig, legal because `noEmit` is
// already true, so a `.ts` specifier is permitted rather than suppressed: tsc type
// checks these three lines normally. Wrangler's esbuild resolves both spellings.
// These three are the whole value-import set because R39 lets this module reach only
// `src/*.ts` files that are themselves dependency-free under plain Node, so a fourth
// value import needs the extension too and has to clear that rule first.
import { idFromSegment, limitFrom, readJson } from "./registry-input.ts";
import { PLACEHOLDER_TITLE } from "./registry-store.ts";
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
 * order: they are MessageRows (id, role, content, tier, created_at), not UIMessages,
 * and nothing here drops created_at on the way to the console.
 *
 * The limit is the list route's own `limitFrom`, not a second clamp: this uses the
 * registry's numbers rather than restating them, so a sidebar page and a transcript
 * page cannot disagree about what "the last N" means, and DEFAULT_LIMIT/MAX_LIMIT
 * come from ./registry-input, which is dependency-free and therefore legal to
 * value-import here.
 */
async function readTranscript(env: Env, id: string, search: URLSearchParams): Promise<Response> {
  const messages: MessageRow[] = await agentStubFor(env, id).messages(limitFrom(search));
  return json({ ok: true, messages });
}

/**
 * Submit and return (R41): the session id travels in the DO this addresses, NOT in
 * the argument list, so `chat` keeps the two arguments every existing caller passes
 * (R65). An absent or unrecognised tier is `undefined`, the same rule src/index.ts
 * applies to /api/message.
 *
 * A successful send then bumps updated_at and nothing else, because the list is
 * `ORDER BY pinned DESC, updated_at DESC` (R54) and a route that only returned the
 * reply would leave the session being typed in where it was. `touch` with no opts:
 * unread is a later phase, since the person sending is reading that session (Task 33).
 */
async function sendMessage(request: Request, env: Env, id: string): Promise<Response> {
  const body = (await readJson(request)) as { content?: unknown; tier?: unknown } | null;
  if (typeof body?.content !== "string" || body.content.length === 0) {
    return fail(400, "content required");
  }
  const tier: ChatTier | undefined =
    body.tier === "primary" || body.tier === "cheap" ? body.tier : undefined;
  const reply: AgentReply = await agentStubFor(env, id).chat(body.content, tier);
  // Any reply counts, including one that carries a code.
  await registryStubFor(env).touch(id);
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
 * `ctx` is unused until the tasks that add background work to these routes (Task 8
 * and Task 22) need it.
 */
export async function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  void ctx;
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
      return readTranscript(env, id, url.searchParams);
    }
    if (sub === "message" && request.method === "POST") return sendMessage(request, env, id);
    return fail(404, "not found");
  }

  return fail(404, "not found");
}
