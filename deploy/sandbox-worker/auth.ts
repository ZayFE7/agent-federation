// The zay-sandbox worker's bearer gate. This is a MIRROR of the two helpers at
// the top of src/auth.ts, and it has to be: `deploy/sandbox-worker` is a
// separate deploy with its own bundle, so it cannot import the brain's module.
// Duplication here is the cost of that split; tests/workspace.test.mjs pins
// both properties (fail-closed on an unset secret, constant-time compare) with
// the same assertions src/auth.ts is pinned by, so the two copies cannot drift
// into different rules while both still look like "the auth check".
//
// WHY IT CANNOT BE THE LINE IT REPLACED. `deploy/sandbox-worker/src/index.ts`
// used to compare `request.headers.get("authorization") !== \`Bearer
// ${env.SBOX_TOKEN}\``. With the secret unset, that evaluates the right-hand
// side to the literal string "Bearer undefined", so a caller who guessed the
// shape of the check was authorized on a worker that runs arbitrary shell. That
// is the same bug src/index.ts had before Task 7 moved it here.
//
// Imports nothing, so an offline Node test can load it.

/** Length check, then a constant-time compare (no early exit on mismatch). */
export function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * True only when a non-empty `SBOX_TOKEN` is configured AND the bearer token in
 * `header` matches it. Fails CLOSED: an unset, empty, or whitespace-only secret
 * rejects every request, and a bare "Bearer undefined" never authenticates.
 */
export function authed(header: string | null, expected: string | undefined): boolean {
  const token = (expected ?? "").trim();
  if (!token) return false;
  const got = (header ?? "").replace(/^Bearer\s+/i, "").trim();
  return safeEq(got, token);
}
