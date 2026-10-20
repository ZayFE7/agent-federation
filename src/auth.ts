// The worker's shared auth gate (plan Task 7).
//
// Moved out of src/index.ts verbatim in behaviour, with one copy left, because
// src/index.ts value-imports ./agent -> `agents` -> `cloudflare:workers`, which no
// offline Node test can resolve. src/routes.ts may import nothing but types and this
// file (R39), so the helpers that guard its routes have to live in a module that is
// itself dependency-free. Same reason src/registry-input.ts exists.
//
// Later tasks extend THIS file rather than restating the rules: Task 22 adds
// `tokenOk`, Task 35 adds `vaultAuthed`.

import type { Env } from "./types";

/** Length-check then constant-time string compare (no early exit on mismatch). */
export function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * True only when a non-empty AGENT_API_KEY is configured AND the request's bearer
 * token matches it. Fails CLOSED: an unset/empty key rejects every request, and a
 * bare "Bearer undefined" no longer authenticates.
 */
export function authed(request: Request, env: Env): boolean {
  const key = (env.AGENT_API_KEY ?? "").trim();
  if (!key) return false;
  const got = (request.headers.get("Authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  return safeEq(got, key);
}
