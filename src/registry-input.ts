// The pure input handling for the registry Durable Object's /registry/... HTTP
// surface: query params, URL segments, request bodies. Moved out of
// src/registry.ts verbatim in behavior, so a Node test can EXECUTE it instead of
// regexing it (R64 I3); the route table itself stays in the DO.
//
// Dependency-free by rule: types only, no runtime import, no `agents`, so plain
// Node can import it (the plan's D6 limit, restated in progress.md R47).
//
// The surface is defense-in-depth, not the only gate: the worker proxies to it,
// and a DO must not depend on the worker having checked.

import type { SessionRow } from "./registry-store";

/** Default and ceiling for the HTTP list, matching the route contract in Task 7. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function limitFrom(search: URLSearchParams): number {
  const raw = Number(search.get("limit"));
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(raw), MAX_LIMIT);
}

/** Every id this DO reads comes from a URL segment; the value is always bound. */
export function idFromSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

/** A JSON integer, or null for anything else. Untrusted columns get rejected, not guessed at. */
export function wholeNumber(value: unknown): number | null {
  // A fraction is rejected, not floored: a fractional `unread` would make the badge arithmetic drift.
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * A request body read as JSON, or null when it is not JSON. Nothing here trusts
 * the shape: a row missing a required column is rejected, not coerced.
 *
 * Session ids are treated as opaque strings. The one copy of the id rule is
 * `isSessionId()` in src/session-scope.ts (R38), which Task 8 creates; neither
 * this module nor the DO may restate that regex.
 */
export function rowFrom(body: unknown): SessionRow | null {
  if (typeof body !== "object" || body === null) return null;
  const row = body as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0) return null;
  if (typeof row.title !== "string" || row.title.length === 0) return null;
  const created_at = wholeNumber(row.created_at);
  const updated_at = wholeNumber(row.updated_at);
  if (created_at === null || updated_at === null) return null;
  // An absent key, or an explicit null, means 0 exactly as it did before the move.
  // A present fraction means the caller is wrong, so the row is rejected, not floored.
  const unread = row.unread === undefined || row.unread === null ? 0 : wholeNumber(row.unread);
  const pinned = row.pinned === undefined || row.pinned === null ? 0 : wholeNumber(row.pinned);
  if (unread === null || pinned === null) return null;
  return {
    id: row.id,
    title: row.title,
    created_at,
    updated_at,
    workspace_ref: typeof row.workspace_ref === "string" ? row.workspace_ref : null,
    unread,
    pinned,
  };
}

/** Parsed JSON body, or null when the body is absent or malformed. */
export async function readJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
