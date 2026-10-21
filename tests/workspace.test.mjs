// Contract tests for deploy/sandbox-worker/workspace.ts and auth.ts: the KV
// snapshot/restore core and the sandbox worker's bearer gate (plan Task 27,
// rescope R26).
//
// What is pinned here and why each one is the thing that bites:
//
// - The mirrored key scheme must produce byte-identical names to
//   src/workspace-keys.ts. The two trees are separate deploys, so nothing may
//   import across them; this test is allowed to, and it is the only thing that
//   keeps the copies from drifting into two different namespaces for the same
//   session (prescan F15).
// - The size gate runs on a number `stat` produced INSIDE the sandbox, before
//   the bytes leave it. A rejected snapshot must not `put` and must not delete,
//   so an over-limit turn cannot destroy the last good copy.
// - `restore` answers three states the shipped code conflates into one swallowed
//   catch: nothing was ever saved, the pointer says bytes exist but KV has not
//   replicated them, and the bytes are there but the extract failed. None of
//   them may report success.
// - There is no base64 on either side anymore. The old shape echoed a base64
//   tar through a shell argument and died around 1-2 MB at MAX_ARG_STRLEN; the
//   fake kv records the value it was handed so a test can fail the moment
//   somebody reintroduces a string.
// - The gate fails CLOSED: with SBOX_TOKEN unset every request is unauthorized,
//   including one that sends the literal "Bearer undefined", on a worker that
//   runs arbitrary shell.
//
// Plain Node, no framework, no build step: run with `node tests/workspace.test.mjs`.
// Silent on success (exit 0). Prints every failure and exits 1 otherwise.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { authed, safeEq } from "../deploy/sandbox-worker/auth.ts";
import {
  B64_PATH,
  MAX_MANIFEST_ENTRIES,
  SNAPSHOT_LIMIT_BYTES,
  TAR_PATH,
  buildTarCommand,
  dropWorkspace,
  manifestKey,
  measureSnapshot,
  parseManifest,
  readArchive,
  restore,
  snapshot,
  tarKey,
} from "../deploy/sandbox-worker/workspace.ts";

const failures = [];

async function check(name, fn) {
  try {
    await fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

const noSleep = async () => {};

// --------------------------------------------------------------- fixtures ----

// The field layout captured live from the E2B "base" template (GNU tar 1.34,
// `--numeric-owner`): mode, `uid/gid` as ONE field, size, ISO date, clock time,
// member name. Sizes are right-aligned in a padded column.
const ISO_LISTING = [
  "drwxr-xr-x 1000/1000         0 2026-10-21 09:00 ./",
  "-rw-r--r-- 1000/1000       118 2026-10-21 09:00 ./README.md",
  "drwxr-xr-x 1000/1000         0 2026-10-21 09:00 ./src/",
  "-rw-r--r-- 1000/1000      4096 2026-10-21 09:01 ./src/index.ts",
  "-rw-r--r-- 1000/1000  40895536 2026-10-21 09:02 ./data/train.csv",
  "-rw-r--r-- 1000/1000      2048 2026-10-21 09:03 ./my  report.txt",
].join("\n") + "\n";

// The same tree from a tar that prints a named owner and a locale month: mode,
// owner, group, size, month, day, year-or-time, member name. Two more leading
// fields than the layout above, which is exactly why the parser anchors on the
// date instead of counting columns.
const CLASSIC_LISTING = [
  "drwxr-xr-x user  user         0 Oct 21  2026 ./",
  "-rw-r--r-- user  user       118 Oct 21  2026 ./README.md",
  "drwxr-xr-x user  user         0 Oct 21  2026 ./src/",
  "-rw-r--r-- user  user      4096 Oct 21 09:01 ./src/index.ts",
  "-rw-r--r-- user  user  40895536 Oct 21  2026 ./data/train.csv",
  "-rw-r--r-- user  user      2048 Oct 21 09:03 ./my  report.txt",
].join("\n") + "\n";

function gzipBytes(byteLength) {
  const b = new Uint8Array(byteLength);
  b[0] = 0x1f;
  b[1] = 0x8b;
  return b;
}

function base64Bytes(text) {
  const b = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) b[i] = text.charCodeAt(i);
  return b;
}

function fakeSandbox(spec = {}) {
  const calls = [];
  const files = new Map();
  let reads = 0;
  let writes = 0;
  const sandbox = {
    calls,
    files,
    stats: () => ({ reads, writes }),
    commands: {
      async run(cmd) {
        calls.push(cmd);
        if (cmd.includes("tar czf")) {
          if (spec.tarExit) return { stdout: "", stderr: "tar: Coward refusing to continue", exitCode: spec.tarExit };
          files.set(TAR_PATH, spec.tarData ?? gzipBytes(2048));
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (cmd.includes("stat -c %s")) {
          const data = files.get(TAR_PATH);
          return { stdout: String(spec.gzipBytes ?? (data ? data.byteLength : 0)) + "\n", stderr: "", exitCode: 0 };
        }
        if (cmd.includes("sha256sum")) {
          return { stdout: `${spec.sha ?? "a".repeat(64)}  ${TAR_PATH}\n`, stderr: "", exitCode: 0 };
        }
        if (cmd.includes("tar tzvf")) {
          return { stdout: spec.listing ?? ISO_LISTING, stderr: "", exitCode: 0 };
        }
        if (cmd.includes("tar xzf") || cmd.includes("base64 -d")) {
          if (spec.extractExit) return { stdout: "", stderr: "tar: Unexpected EOF", exitCode: spec.extractExit };
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
    async readFile(path) {
      reads++;
      const data = files.get(path);
      if (!data) throw new Error(`ENOENT: ${path}`);
      return data;
    },
    async writeFile(path, data) {
      writes++;
      files.set(path, data);
    },
  };
  return sandbox;
}

function fakeKv(spec = {}) {
  // A Map handed in is the live store: tests assert against the same object the
  // fake mutates. An array is a seed, copied so the caller's literal stays clean.
  const store = spec.store instanceof Map ? spec.store : new Map(spec.store ?? []);
  const puts = [];
  const deletes = [];
  const gets = [];
  let listCalls = 0;
  const kv = {
    store,
    puts,
    deletes,
    gets,
    listCalls: () => listCalls,
    async put(key, value, metadata) {
      if (spec.putError) {
        const err = new Error(spec.putError);
        err.name = spec.putErrorName ?? "Error";
        throw err;
      }
      puts.push({ key, value, metadata });
      store.set(key, value);
    },
    async get(key) {
      gets.push(key);
      if (spec.visibleFromAttempt && spec.seen === undefined) spec.seen = 0;
      if (spec.visibleFromAttempt) {
        spec.seen++;
        if (spec.seen < spec.visibleFromAttempt) return null;
      }
      const v = store.get(key);
      if (v === undefined) return null;
      return v;
    },
    async delete(key) {
      deletes.push(key);
      store.delete(key);
    },
    async list() {
      listCalls++;
      return { keys: [] };
    },
  };
  return kv;
}

const SID = "s7a";

// The cross-tree key mirror lives in tests/workspace-keys.test.mjs, which imports
// both modules and compares what they produce. This file tests behaviour.

// ---------------------------------------------------------- tar commands ----

await check("buildTarCommand builds one gzip tar, deterministically, excluding build output", () => {
  const cmd = buildTarCommand("/home/user");
  assert.ok(cmd.includes("tar czf " + TAR_PATH), "must write a gzip tar to the fixed path");
  assert.ok(cmd.startsWith("cd /home/user"), "must tar from the session home");
  assert.ok(cmd.trim().endsWith("."), "must archive the home directory itself");
  for (const flag of ["--sort=name", "--mtime=@0", "--numeric-owner", "--warning=no-file-changed"]) {
    assert.ok(cmd.includes(flag), `missing ${flag}: a non-deterministic tar re-saves every turn`);
  }
  for (const ex of ["node_modules", ".git", "dist", "build", ".next", ".cache", "__pycache__"]) {
    assert.ok(cmd.includes(`--exclude=${ex}`), `missing --exclude=${ex}`);
  }
  assert.ok(!/base64/.test(cmd), "no base64 on the write side");
});

await check("measureSnapshot takes every number from the sandbox, not the worker", async () => {
  const sandbox = fakeSandbox({ gzipBytes: 2048 });
  const m = await measureSnapshot(sandbox, "/home/user");
  assert.equal(m.bytes, 2048, "bytes is the stat of the tar inside the sandbox");
  assert.equal(m.sha256, "a".repeat(64), "sha comes from sha256sum in the sandbox");
  assert.equal(m.files, 4, "four file members, directories are not files");
  assert.equal(m.rawBytes, 118 + 4096 + 40895536 + 2048);
  assert.deepEqual(m.biggest, [
    "data/train.csv",
    "src/index.ts",
    "my  report.txt",
  ], "up to three members, largest first, paths without the leading ./");
  assert.deepEqual(
    sandbox.calls.map((c) => c.split(" ")[0]),
    ["cd", "stat", "sha256sum", "tar"],
    "measure is four commands, in order"
  );
});

await check("measureSnapshot reports a failed tar as a failed tar", async () => {
  const sandbox = fakeSandbox({ tarExit: 2 });
  await assert.rejects(() => measureSnapshot(sandbox, "/home/user"), /tar/);
});

// --------------------------------------------------------- manifest parse ----

// Captured verbatim from a live E2B "base" sandbox on 2026-10-21, Task 27 step 4.
// The two fixtures above are modelled on this; this one is the ground, and the
// first version of the parser read none of it, which is how every real snapshot
// came back reason "empty" with a 2209-byte tar in hand.
const LIVE_LISTING = [
  "drwxr-xr-x 1000/1000         0 1970-01-01 00:00 ./",
  "-rw-r--r-- 1000/1000       220 1970-01-01 00:00 ./.bash_logout",
  "-rw-r--r-- 1000/1000      3526 1970-01-01 00:00 ./.bashrc",
  "-rw-r--r-- 1000/1000       807 1970-01-01 00:00 ./.profile",
  "-rw-r--r-- 1000/1000         3 1970-01-01 00:00 ./a.txt",
  "-rw-r--r-- 1000/1000      5000 1970-01-01 00:00 ./b.txt",
  "drwxr-xr-x 1000/1000         0 1970-01-01 00:00 ./sub/",
  "-rw-r--r-- 1000/1000         2 1970-01-01 00:00 ./sub/c.txt",
].join("\n") + "\n";

await check("the listing the live sandbox really prints parses file for file", () => {
  const { files, total, bytesTotal, biggest, truncated } = parseManifest(LIVE_LISTING);
  assert.equal(truncated, false);
  assert.equal(total, 6, "six file members, the two directories dropped");
  assert.deepEqual(
    files.map((f) => [f.path, f.bytes]),
    [[".bash_logout", 220], [".bashrc", 3526], [".profile", 807], ["a.txt", 3], ["b.txt", 5000], ["sub/c.txt", 2]]
  );
  assert.equal(bytesTotal, 9558);
  assert.deepEqual(biggest, ["b.txt", ".bashrc", ".profile"]);
});

await check("a live-shaped listing is a snapshot, not an empty home", async () => {
  const sandbox = fakeSandbox({ gzipBytes: 2281, listing: LIVE_LISTING });
  const kv = fakeKv();
  const r = await snapshot(sandbox, kv, SID);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.reason, undefined);
  assert.equal(r.files, 6);
  assert.equal(r.rawBytes, 9558);
  assert.equal(kv.puts.length, 2);
});

await check("parseManifest reads the GNU tar verbose listing", () => {
  const { files, truncated } = parseManifest(ISO_LISTING);
  assert.equal(truncated, false);
  assert.equal(files.length, 4);
  assert.deepEqual(files[0], { path: "README.md", bytes: 118, mtime: "2026-10-21 09:00" });
  assert.equal(files[1].path, "src/index.ts");
  assert.equal(files[3].path, "my  report.txt", "internal spaces in a name survive");
  assert.ok(!files.some((f) => f.path.startsWith("./")), "the leading ./ is stripped");
  assert.ok(!files.some((f) => f.path.endsWith("/")), "directory members are not files");
});

await check("parseManifest reads the month-day-year listing without changing the numbers", () => {
  const { files } = parseManifest(CLASSIC_LISTING);
  const iso = parseManifest(ISO_LISTING).files;
  assert.deepEqual(
    files.map((f) => [f.path, f.bytes]),
    iso.map((f) => [f.path, f.bytes])
  );
});

await check("parseManifest truncates to the UI ceiling and says so", () => {
  const lines = [];
  for (let i = 0; i < MAX_MANIFEST_ENTRIES + 4000; i++) {
    lines.push(`-rw-r--r-- 1000/1000        10 2026-10-21 09:00 ./f${i}.txt`);
  }
  const { files, truncated, total } = parseManifest(lines.join("\n"));
  assert.equal(files.length, MAX_MANIFEST_ENTRIES);
  assert.equal(truncated, true);
  assert.equal(total, MAX_MANIFEST_ENTRIES + 4000, "the real count survives the truncation");
});

await check("parseManifest ignores the trailer tar prints", () => {
  const { files } = parseManifest(ISO_LISTING + "tar: Exiting with failure status\n");
  assert.equal(files.length, 4);
});

// ------------------------------------------------------------- snapshot ----

await check("a successful snapshot stores raw gzip and a manifest under the derived names", async () => {
  const sandbox = fakeSandbox({ gzipBytes: 2048 });
  const kv = fakeKv();
  const r = await snapshot(sandbox, kv, SID);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.bytes, 2048);
  assert.equal(r.files, 4);
  assert.equal(r.rawBytes, 118 + 4096 + 40895536 + 2048);
  assert.equal(r.limit, SNAPSHOT_LIMIT_BYTES);
  assert.equal(r.sha256, "a".repeat(64));
  assert.equal(r.key, tarKey(SID));
  assert.equal(r.unchanged, false);
  assert.ok(r.ms >= 0);
  assert.equal(kv.puts.length, 2, "the tar and its manifest, nothing else");
  const [tar, man] = kv.puts;
  assert.equal(tar.key, `ws:tar:${SID}`);
  assert.equal(man.key, `ws:man:${SID}`);
  assert.ok(tar.value instanceof ArrayBuffer, "the tar is an ArrayBuffer, not a string");
  const head = new Uint8Array(tar.value, 0, 2);
  assert.deepEqual([head[0], head[1]], [0x1f, 0x8b], "raw gzip bytes, no base64 wrapper");
  assert.ok(man.metadata && typeof man.metadata.sha256 === "string");
  const manifest = JSON.parse(new TextDecoder().decode(man.value));
  assert.equal(manifest.filesCount, 4);
  assert.equal(manifest.bytes, 2048);
  assert.equal(manifest.entries.length, 4);
  assert.equal(manifest.entries[0].path, "README.md");
  assert.equal(typeof manifest.updatedAt, "number");
});

await check("an over-limit tar is refused before its bytes leave the sandbox", async () => {
  const over = SNAPSHOT_LIMIT_BYTES + 1;
  const sandbox = fakeSandbox({ gzipBytes: over, tarData: gzipBytes(64) });
  const kv = fakeKv({ store: [[`ws:tar:${SID}`, gzipBytes(100)]] });
  const r = await snapshot(sandbox, kv, SID);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "too_large");
  assert.equal(r.bytes, over, "the response carries the number that was measured");
  assert.equal(r.limit, SNAPSHOT_LIMIT_BYTES);
  assert.deepEqual(r.biggest.slice(0, 1), ["data/train.csv"]);
  assert.equal(sandbox.stats().reads, 0, "readFile never runs: the gate is on stat, not on transfer");
  assert.equal(kv.puts.length, 0, "nothing is written");
  assert.equal(kv.deletes.length, 0, "and nothing is removed");
  assert.ok(kv.store.has(`ws:tar:${SID}`), "the previously good snapshot survives an over-limit turn");
});

await check("the size gate does not depend on the listing it could not read", async () => {
  // The live failure this pins: a 60 MB random file made a tar whose listing the
  // first parser read as zero members, and the response said "empty" instead of
  // "too_large". `stat` is the gate; a listing parse cannot soften it.
  const over = 30 * 1024 * 1024;
  const sandbox = fakeSandbox({ gzipBytes: over, listing: "", tarData: gzipBytes(64) });
  const kv = fakeKv();
  const r = await snapshot(sandbox, kv, SID);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.reason, "too_large");
  assert.equal(r.bytes, over);
  assert.equal(r.files, 0);
  assert.equal(kv.puts.length, 0);
});

await check("a matching priorSha256 costs a read of the pointer and no write", async () => {
  const sandbox = fakeSandbox({ gzipBytes: 2048, sha: "b".repeat(64) });
  const kv = fakeKv();
  const r = await snapshot(sandbox, kv, SID, { priorSha256: "b".repeat(64) });
  assert.equal(r.ok, true);
  assert.equal(r.unchanged, true);
  assert.equal(r.bytes, 2048, "unchanged still reports what is there");
  assert.equal(kv.puts.length, 0, "this is what keeps 1,000 writes/day away from a chatty session");
});

await check("an empty home is reported as empty and never overwrites a real snapshot", async () => {
  const sandbox = fakeSandbox({ listing: "drwxr-xr-x 1000/1000         0 2026-10-21 09:00 ./\n" });
  const kv = fakeKv({ store: [[`ws:tar:${SID}`, gzipBytes(100)]] });
  const r = await snapshot(sandbox, kv, SID);
  assert.equal(r.ok, true);
  assert.equal(r.reason, "empty");
  assert.equal(r.files, 0);
  assert.equal(kv.puts.length, 0, "a fresh boot must not erase the snapshot it failed to restore");
  assert.equal(kv.deletes.length, 0);
});

await check("a failing tar is tar_failed, with no write and no delete", async () => {
  const sandbox = fakeSandbox({ tarExit: 2 });
  const kv = fakeKv();
  const r = await snapshot(sandbox, kv, SID);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "tar_failed");
  assert.equal(r.bytes, 0);
  assert.equal(r.key, null);
  assert.equal(kv.puts.length, 0);
});

await check("Cloudflare refusing the write is classified, and the old snapshot survives", async () => {
  const cases = [
    ["the namespace is full", "Namespace has reached its allotted capacity", "kv_full"],
    ["the daily budget", "You have exceeded the number of writes allowed per day", "write_budget"],
    ["anything else", "socket hang up", "kv_write_failed"],
  ];
  for (const [label, message, reason] of cases) {
    const sandbox = fakeSandbox({ gzipBytes: 2048 });
    const kv = fakeKv({ store: [[`ws:tar:${SID}`, gzipBytes(100)]], putError: message });
    const r = await snapshot(sandbox, kv, SID);
    assert.equal(r.ok, false, label);
    assert.equal(r.reason, reason, `${label}: got ${r.reason}`);
    assert.equal(r.bytes, 2048, `${label}: the measured size is still the honest number`);
    assert.equal(kv.deletes.length, 0, `${label}: the stored copy is untouched`);
  }
});

await check("a session id that could address another session never reaches KV", async () => {
  const sandbox = fakeSandbox();
  const kv = fakeKv();
  await assert.rejects(() => snapshot(sandbox, kv, "a/b"), /unsafe session id/);
  assert.equal(kv.puts.length, 0);
  assert.equal(sandbox.calls.length, 0, "the guard runs before the tar, not after the write");
});

// -------------------------------------------------------------- restore ----

function seed(spec = {}) {
  const gzip = spec.legacy ? base64Bytes("H4sIAAAAlegacybase64tar") : gzipBytes(spec.bytes ?? 2048);
  const store = new Map([[`ws:tar:${SID}`, gzip.buffer.slice(gzip.byteOffset, gzip.byteOffset + gzip.byteLength)]]);
  if (spec.manifest !== false) {
    const man = new TextEncoder().encode(
      JSON.stringify({ filesCount: 4, bytes: spec.bytes ?? 2048, entries: [], updatedAt: 1 })
    );
    store.set(`ws:man:${SID}`, man.buffer.slice(man.byteOffset, man.byteOffset + man.byteLength));
  }
  return { store, sandbox: fakeSandbox(spec), kv: fakeKv({ store, ...spec.kvSpec }) };
}

await check("nothing ever saved is a normal answer, reported as no_snapshot", async () => {
  const sandbox = fakeSandbox();
  const kv = fakeKv();
  const r = await restore(sandbox, kv, SID);
  assert.equal(r.ok, true);
  assert.equal(r.restored, false);
  assert.equal(r.reason, "no_snapshot");
  assert.equal(r.bytes, 0);
  assert.equal(r.attempts, 1, "with no pointer claiming bytes there is nothing to wait for");
  assert.equal(sandbox.calls.length, 0, "an empty workspace is never booted and called a restore");
});

await check("a pointer that claims bytes waits for replication, then restores", async () => {
  const { store, sandbox, kv } = seed({ bytes: 2048 });
  const spec = { store, visibleFromAttempt: 2, seen: 0 };
  const waiting = fakeKv(spec);
  const r = await restore(sandbox, waiting, SID, { bytes: 2048 }, { sleep: noSleep });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restored, true);
  assert.equal(r.attempts, 2);
  assert.equal(r.bytes, 2048);
  assert.equal(r.files, 4, "the file count comes from the manifest, not from guessing");
  assert.ok(sandbox.calls.some((c) => c.includes("tar xzf")));
});

await check("a short read against the pointer is size_mismatch after at most 3 tries", async () => {
  const { store, sandbox } = seed({ bytes: 800 });
  const kv = fakeKv({ store });
  const r = await restore(sandbox, kv, SID, { bytes: 1200 }, { sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.restored, false);
  assert.equal(r.reason, "size_mismatch");
  assert.equal(r.attempts, 3);
  assert.equal(r.bytes, 800, "it reports what KV actually returned");
  assert.equal(r.expectedBytes, 1200);
  assert.ok(!sandbox.calls.some((c) => c.includes("tar xzf")), "a truncated archive is never extracted");
});

await check("a pointer that never becomes visible is not_visible_yet, not an empty workspace", async () => {
  const { sandbox } = seed();
  const kv = fakeKv({ store: new Map(), visibleFromAttempt: 99 });
  const r = await restore(sandbox, kv, SID, { bytes: 2048 }, { sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.restored, false);
  assert.equal(r.reason, "not_visible_yet");
  assert.equal(r.attempts, 3);
  assert.equal(sandbox.calls.length, 0);
});

await check("bytes present but unextractable is extract_failed and keeps the stored copy", async () => {
  const { store, sandbox } = seed({ extractExit: 2 });
  const kv = fakeKv({ store });
  const r = await restore(sandbox, kv, SID);
  assert.equal(r.ok, false);
  assert.equal(r.restored, false);
  assert.equal(r.reason, "extract_failed");
  assert.equal(r.bytes, 2048, "the copy in KV is still there, so the number is still true");
  assert.equal(kv.deletes.length, 0);
  assert.ok(sandbox.files.has(TAR_PATH), "the archive was written to the sandbox for the extract");
});

await check("a snapshot written by the old base64 format still restores, and says it is legacy", async () => {
  const { store, sandbox } = seed({ legacy: true });
  const kv = fakeKv({ store });
  const r = await restore(sandbox, kv, SID);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restored, true);
  assert.equal(r.legacy, true, "gzip magic absent means the old encoding, and the user is told");
  assert.equal(r.files, 0, "a legacy snapshot has no manifest, so no file count is claimed");
  assert.ok(sandbox.calls.some((c) => c.includes("base64 -d")), "the decode runs in the sandbox");
  assert.ok(!sandbox.calls.some((c) => c.includes("tar xzf " + TAR_PATH)), "not fed to the raw path");
  assert.equal(kv.puts.length, 0, "restore never rewrites the stored copy");
});

await check("restore never hands the tar to a shell argument", async () => {
  const { store, sandbox } = seed();
  const kv = fakeKv({ store });
  await restore(sandbox, kv, SID);
  for (const cmd of sandbox.calls) {
    assert.ok(cmd.length < 2000, `shell command of ${cmd.length} bytes: the ARG_MAX failure is back`);
  }
});

// ------------------------------------------------- archive and forgetting ----

await check("readArchive returns the raw bytes and their length", async () => {
  const { store } = seed({ bytes: 1234 });
  const kv = fakeKv({ store });
  const a = await readArchive(kv, SID);
  assert.equal(a.bytes, 1234);
  assert.ok(a.body instanceof ArrayBuffer);
  assert.equal((await readArchive(fakeKv(), SID)), null);
});

await check("dropWorkspace deletes the two derived names and never lists", async () => {
  const { store } = seed();
  const kv = fakeKv({ store });
  const r = await dropWorkspace(kv, SID);
  assert.deepEqual(r.deleted, [`ws:tar:${SID}`, `ws:man:${SID}`]);
  assert.equal(kv.listCalls(), 0, "list() is one of the three operations the free plan caps at 1,000/day");
  assert.equal(store.size, 0);
});

// ------------------------------------------------------------ the gate ----

await check("the gate fails closed when the secret is unset", () => {
  for (const header of [null, "", "Bearer", "Bearer undefined", "Bearer ", "basic Zm9vOmJhcg=="]) {
    assert.equal(authed(header, ""), false, `unauthorized accepted ${JSON.stringify(header)}`);
    assert.equal(authed(header, "   "), false, "a whitespace-only secret is not a secret");
  }
});

await check("the literal Bearer undefined never authenticates", () => {
  assert.equal(authed("Bearer undefined", "undefined"), true, "the token IS the word undefined here");
  assert.equal(authed("Bearer undefined", ""), false);
  assert.equal(authed(null, "sekret"), false);
  assert.equal(authed("Bearer sekret", "sekret"), true);
  assert.equal(authed("bearer  SEKRET ", "SEKRET"), true, "case-insensitive scheme, trimmed token");
  assert.equal(authed("Bearer sekret2", "sekret"), false);
});

await check("safeEq compares by content, not by reference, and survives unicode", () => {
  assert.equal(safeEq("a", "a"), true);
  assert.equal(safeEq("a", "b"), false);
  assert.equal(safeEq("ab", "a"), false);
  assert.equal(safeEq("", ""), true, "safeEq is a comparer; the gate above is what fails closed");
  assert.equal(safeEq("ünïcødé", "ünïcødé"), true);
  assert.equal(safeEq("ünïcødé", "ünïcøden"), false);
});

// -------------------------------------------------------- the route file ----

await check("the shipped route file has no fail-open comparison and no swallowed restore", () => {
  const source = readFileSync(
    new URL("../deploy/sandbox-worker/src/index.ts", import.meta.url),
    "utf8"
  );
  assert.ok(!/!==\s*`Bearer/.test(source), "the old template-literal comparison is a fail-open gate");
  assert.ok(!/env\.SBOX_TOKEN\}/.test(source), "SBOX_TOKEN must not be interpolated into a comparison");
  assert.ok(/authed\(/.test(source), "the gate is used, not reimplemented");
  assert.ok(!/no snapshot yet/.test(source), "the catch that swallowed every restore state is gone");
  for (const route of [
    "/workspace/snapshot",
    "/workspace/restore",
    "/workspace/manifest",
    "/workspace/archive",
    "/workspace/forget",
  ]) {
    assert.ok(source.includes(`"${route}"`), `route ${route} is missing`);
  }
  assert.ok(!/import .* from "e2b"/.test(readFileSync(new URL("../deploy/sandbox-worker/workspace.ts", import.meta.url), "utf8")), "workspace.ts must stay importable offline");
});

await check("auth.ts imports nothing either, so this test can load it", () => {
  const source = readFileSync(new URL("../deploy/sandbox-worker/auth.ts", import.meta.url), "utf8");
  assert.equal(/^\s*import\s/m.test(source), false, "an import makes this unmirrorable");
});

// ---------------------------------------------------------------- summary ----

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`workspace: ${failures.length} failed`);
  process.exit(1);
}
