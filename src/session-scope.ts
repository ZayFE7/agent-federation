// The session-scope guard: one copy of what a session id is, and the Durable
// Object's own check that a session belongs to it (plan Task 8, R38).
//
// WHY THIS FILE EXISTS. A session id IS the Durable Object name (R38):
// `idFromName(sessionId)` picks the DO, so an id that does not match the DO
// holding the running code is a cross-session request, not a typo. Two guards
// exist because they stop two different things:
//
//   1. src/routes.ts validates EVERY `:id` with `isSessionId()` before it calls
//      `idFromName`, and answers 400. That is where an attacker-controlled string
//      is actually stopped, and it is also where an id with no registry row is
//      refused (404) before a DO is instantiated for it.
//   2. this module is what the DO itself re-checks, so a routing bug cannot let
//      one session's work run in another session's DO. Defense in depth: a DO must
//      not depend on the worker having checked.
//
// NO FILESYSTEM ANALOGY HERE. A DO name is an opaque string the platform hashes to
// an id, so traversal has no meaning at that layer and never did; `..` and `a/b`
// would each simply be a name. What the shape rule buys is that a client cannot
// steer which id it names and no prefixed id (the deleted `"s:"` form) can sneak
// through. The real risk the routes' existence check closes is orphan state and
// free DO instantiation, not path escape (R73).
//
// DEPENDENCY-FREE BY RULE (R47): this module imports nothing at all, so
// src/routes.ts can value-import it (R39) and plain Node can run
// tests/session-scope.test.mjs against it. Both predicates are pure over their
// arguments: the DO state and the namespace are read only through `toString()`, so
// a test needs no platform types.
//
// A value that crosses a DO RPC boundary arrives in another realm, so a throw here
// is not the contract: `instanceof ScopeError` can never be true in the worker. The
// observable form of a refusal is the `code` field on the reply (src/types.ts).

/**
 * R38: ONE definition of a session id. The bare id, 1 to 40 characters of
 * `[A-Za-z0-9_-]`, and nothing else: no prefix, no separator, no path character.
 * Legacy `main` is a session id like any other, so it passes with no special case.
 */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * The one copy of the rule (Task 23 imports this instead of restating the regex,
 * R38). Anything else, including an empty string, is not a session id.
 */
export function isSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

/** Thrown by `assertSessionScope` for a local caller that wants a throw. */
export class ScopeError extends Error {
  constructor(sessionId: string) {
    super(`this Durable Object does not own session ${JSON.stringify(sessionId)}`);
    this.name = "ScopeError";
  }
}

/**
 * True when this DO is the one `sessionId` addresses: its own id equals the id the
 * namespace resolves for that name.
 *
 * The shape rule is applied first on purpose, so an id that could only match a
 * badly-routed name (a prefix, a path, an empty string) is refused here too rather
 * than reaching `idFromName` from inside the DO.
 *
 * `ctx` is `DurableObjectState` (reachable as `this.ctx` on an `Agent` subclass)
 * and `idFromName` is the namespace's own method, both narrowed to the one thing
 * this reads, so the predicate stays testable offline.
 */
export function sessionScopeOk(
  ctx: { id: { toString(): string } },
  idFromName: (name: string) => { toString(): string },
  sessionId: string
): boolean {
  if (!isSessionId(sessionId)) return false;
  return ctx.id.toString() === idFromName(sessionId).toString();
}

/** The throwing form of the same predicate, for callers that want a throw. */
export function assertSessionScope(
  ctx: { id: { toString(): string } },
  idFromName: (name: string) => { toString(): string },
  sessionId: string
): void {
  if (!sessionScopeOk(ctx, idFromName, sessionId)) {
    throw new ScopeError(sessionId);
  }
}
