// The KV key names for per-session workspace snapshots, the guard in front of
// them, and the size gate (plan Task 26, rescope R26).
//
// WHY THIS FILE EXISTS. One gzip tar per session goes into the KV namespace
// `zay-sandbox` already binds as `SESSIONS`, under `ws:tar:<id>`, with its file
// manifest beside it under `ws:man:<id>`. Nothing ever lists a prefix: the name
// is derived from the session id on both sides, because `list` is one of the
// three operations the free plan caps at 1,000 per day and a list result is
// eventually consistent anyway. Derived names are also the whole reason a guard
// belongs here rather than at the route. A session id that contained `:` or `/`
// could make one derived key read as another session's data, and the worker that
// serves it would have no way to tell. So `assertSafeSessionId` runs BEFORE a key
// is built and refuses rather than normalises.
//
// THE GATE. A KV value caps at 25 MiB on both plans, measured on the stored
// bytes. `SNAPSHOT_LIMIT_BYTES` is one MiB under that on purpose: the ceiling is
// on the value handed to `put`, and a tar that "measured fine" against 25 MiB
// should not be discoverable at the edge. Measured on this repo, the whole tree
// minus `node_modules` and `.git` tars to 450,828 gz bytes (1.7% of one entry);
// the same tree WITH `node_modules` is 92,563,800, 3.5x over the cap. That is why
// the excludes are a rule and not a default.
//
// MIRROR, DO NOT IMPORT. `deploy/sandbox-worker/workspace.ts` needs these same
// strings and lives in a separate deploy, so it carries a copy of this file's
// values. That copy is only safe because it is one file, so this module imports
// NOTHING; tests/workspace-keys.test.mjs pins it (no `import`, no `require`) and
// pins the id rule against `src/session-scope.ts`'s `SESSION_ID_RE`, which is
// where the one real definition of a session id lives (R38). Task 27 adds the
// cross-tree comparison between the two builders (prescan F15).
//
// NEXT VERSION: nothing here changes unless Cloudflare moves a ceiling. If the
// free 1 GB per-account KV storage limit is ever reached, the failure surfaces as
// a `kv_full` reason in the snapshot result, not as a new constant here.

/** Cloudflare's hard cap on one KV key NAME, in bytes. Both plans. */
export const MAX_KEY_BYTES = 512;

/** Cloudflare's hard cap on one stored VALUE, in bytes. Both plans. */
export const KV_ENTRY_BYTES = 25 * 1024 * 1024;

/** The gate: one MiB under `KV_ENTRY_BYTES`, measured on the gzip tar before any transfer. */
export const SNAPSHOT_LIMIT_BYTES = 24 * 1024 * 1024;

/** The manifest the Files tab lists is bounded; `truncated: true` is honest, silence is not. */
export const MAX_MANIFEST_ENTRIES = 1000;

/** A copy of R38's ceiling, kept at or below the real definition in src/session-scope.ts. */
export const MAX_ID_LENGTH = 40;

const SAFE_SESSION_ID = new RegExp(`^[A-Za-z0-9_-]{1,${MAX_ID_LENGTH}}$`);

/**
 * The id, or a throw. Refuses `""`, `/`, `..`, `:`, whitespace, anything outside
 * `[A-Za-z0-9_-]`, and anything longer than `MAX_ID_LENGTH`. The message names the
 * rule, never the value: a rejected id is attacker-controlled text.
 */
export function assertSafeSessionId(sessionId: string): string {
  if (typeof sessionId !== "string" || !SAFE_SESSION_ID.test(sessionId)) {
    throw new Error(
      `unsafe session id: must be 1-${MAX_ID_LENGTH} characters of [A-Za-z0-9_-]`
    );
  }
  return sessionId;
}

/**
 * The key, or a throw. Not reachable from a valid session id, since the longest
 * id allowed builds a 47-byte key: this is the ceiling written down so the next
 * widening has somewhere to fail. Exported for the same reason.
 */
export function assertKeyFits(key: string): string {
  const bytes = new TextEncoder().encode(key).length;
  if (bytes > MAX_KEY_BYTES) {
    throw new Error(`KV key name is ${bytes} bytes, over the ${MAX_KEY_BYTES} byte limit`);
  }
  return key;
}

/** `ws:tar:<id>`, the gzip tar itself, stored as a raw ArrayBuffer. */
export function tarKey(sessionId: string): string {
  return assertKeyFits(`ws:tar:${assertSafeSessionId(sessionId)}`);
}

/** `ws:man:<id>`, the manifest JSON, small enough to read without the archive. */
export function manifestKey(sessionId: string): string {
  return assertKeyFits(`ws:man:${assertSafeSessionId(sessionId)}`);
}

/** `ws:<id>:`, the display label for one session's keys. Never the argument to a `list()` call. */
export function workspacePrefix(sessionId: string): string {
  return assertKeyFits(`ws:${assertSafeSessionId(sessionId)}:`);
}

/** Strictly over the gate. Exactly `SNAPSHOT_LIMIT_BYTES` is allowed. */
export function isOverSnapshotLimit(bytes: number): boolean {
  return bytes > SNAPSHOT_LIMIT_BYTES;
}

/** "41.2 MiB", "24 MiB", "242 KiB". Every card that names a number takes it from here. */
export function formatLimit(bytes: number): string {
  const units: Array<[string, number]> = [
    ["GiB", 1024 * 1024 * 1024],
    ["MiB", 1024 * 1024],
    ["KiB", 1024],
  ];
  for (const [unit, size] of units) {
    if (bytes >= size) {
      const scaled = bytes / size;
      const text = scaled >= 100 ? String(Math.round(scaled)) : String(Number(scaled.toFixed(1)));
      return `${text} ${unit}`;
    }
  }
  return `${Math.round(bytes)} B`;
}

// ------------------------------------------------------- the path guard ----
//
// Task 30 puts a file path in a URL for the first time:
// `DELETE /api/sessions/:id/workspace/files/<path>`. Two things make that a
// guard-shaped problem rather than a lookup. The path arrives percent-encoded and
// is decoded HERE, after the URL layer has already normalized the dots it could
// see, so `x%2f..%2f..%2fetc%2fpasswd` reaches this code as the five segments
// `x .. .. etc passwd`, which no earlier layer ever treated as dots. And the path
// is not a lookup key: it is interpolated into a command that runs as the
// session's own user, so a name that slips through does not read another
// session's file, it deletes one the user meant to keep.
//
// NOT MIRRORED IN deploy/sandbox-worker. The worker never takes a path from a
// request: it takes a whole command the brain built, or a fixed path it chose
// itself. The mirror rule exists for values both sides must agree on, and a
// brain-side URL guard is not one of them.

/** Long enough for any real tree, short enough that a 4 MB filename is a refusal. */
export const MAX_PATH_BYTES = 512;

/**
 * The path, or null. Absolute paths, empty segments, dots and dot-dots, embedded
 * control characters and anything over MAX_PATH_BYTES are refused. A name with a
 * space, a quote or a non-ASCII character is accepted: those are legal Linux
 * filenames, and `quoteShellArg` is what makes them safe to hand to rm.
 */
export function safeWorkspacePath(raw: string): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  if (new TextEncoder().encode(raw).length > MAX_PATH_BYTES) return null;
  if (hasControlChar(raw)) return null;
  if (raw.charAt(0) === "/") return null;
  const segments = raw.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
  }
  return segments.join("/");
}

/**
 * C0 controls and DEL are refused, tab and newline included: a filename that
 * prints as two lines can impersonate another row in the Files tab, and no real
 * file in this workspace needs one.
 */
function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Stable prefix for one file's `.blip/versions` backups. */
export function versionBaseName(path: string): string {
  return path
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\//g, "__")
    .slice(0, 120);
}

/**
 * POSIX single quotes, with every inner quote closed, escaped and reopened. This
 * is the whole reason a legal filename is safe to pass: inside single quotes the
 * shell reads `$`, backticks, `;`, `|` and `&` as literal characters.
 */
export function quoteShellArg(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'";
}
