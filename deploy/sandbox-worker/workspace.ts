// Snapshot and restore one session's work as a single gzip tar in the KV
// namespace `zay-sandbox` already binds as `SESSIONS` (plan Task 27, rescope
// R26). No new binding, no new bucket, no base64.
//
// WHAT CHANGED AND WHY IT MATTERS. The shape this replaces read a whole home
// directory through `tar czf - | base64 -w0` into a stdout string, stored that
// string in KV, and restored it by echoing it back into a shell argument. That
// design has two ceilings nobody measured: base64 inflates the payload by 4/3
// before it hits a 25 MiB value cap, and `MAX_ARG_STRLEN` kills the restore at
// roughly 1-2 MB on a single Linux argument, which is why saving an app quietly
// stopped working as soon as the app was worth saving. Here the bytes move
// through the sandbox's file API as an `ArrayBuffer`, and the only thing a shell
// argument ever carries is a path.
//
// THE MEASUREMENT IS THE GATE. `stat`, `sha256sum` and the member listing all
// run inside the microVM. A Free-plan Worker gets 10 ms of CPU per action, so it
// must not transcode megabytes; it reads one integer and decides before any byte
// crosses the boundary. Over `SNAPSHOT_LIMIT_BYTES` the answer is `too_large`
// with the number in it, and the previously stored snapshot is left exactly as
// it was: an over-limit turn must never be able to destroy a good copy.
//
// MIRROR, DO NOT IMPORT. The key names and ceilings below are a copy of
// src/workspace-keys.ts. The two trees are separate deploys, so no product
// module may reach across; tests/workspace.test.mjs imports both copies and
// compares them for the same session id, which is the only thing that makes a
// hand-written mirror safe (prescan F15).
//
// E2B IS AN INJECTED PORT, NOT AN IMPORT. `e2b` is not installed in the
// repo-clone tree, so a test that pulled it would fail for the wrong reason.
// Pinned against the typings of the version the deploy tree runs
// (`e2b@1.13.2`, `dist/index.d.ts`):
//   files.read(path, { format: "bytes" }): Promise<Uint8Array>
//   files.write(path, data: string | ArrayBuffer | Blob | ReadableStream): Promise<WriteInfo>
//   commands.run(cmd, opts?): Promise<{ exitCode: number; stdout: string; stderr: string }>

/** Where the tar is built inside the microVM. Never a directory the user sees. */
export const TAR_PATH = "/tmp/ws.tar.gz";
/** Where a legacy base64 snapshot is staged so the sandbox can decode it. */
export const B64_PATH = "/tmp/ws.b64";
/** Mirrors `SANDBOX_HOME` in src/capabilities.ts and deploy/sandbox-worker/src/index.ts; tests/paths.test.mjs pins all three. */
const DEFAULT_HOME = "/home/user";

const TAR_TIMEOUT_MS = 60_000;
const STAT_TIMEOUT_MS = 15_000;
const RETRY_BASE_MS = 2_000;
const RESTORE_ATTEMPTS = 3;

// ------------------------------------------------- mirrored from keys module ----

export const MAX_KEY_BYTES = 512;
export const KV_ENTRY_BYTES = 25 * 1024 * 1024;
export const SNAPSHOT_LIMIT_BYTES = 24 * 1024 * 1024;
export const MAX_MANIFEST_ENTRIES = 1000;
export const MAX_ID_LENGTH = 40;

const SAFE_SESSION_ID = new RegExp(`^[A-Za-z0-9_-]{1,${MAX_ID_LENGTH}}$`);

export function assertSafeSessionId(sessionId: string): string {
  if (typeof sessionId !== "string" || !SAFE_SESSION_ID.test(sessionId)) {
    throw new Error(
      `unsafe session id: must be 1-${MAX_ID_LENGTH} characters of [A-Za-z0-9_-]`
    );
  }
  return sessionId;
}

export function assertKeyFits(key: string): string {
  const bytes = new TextEncoder().encode(key).length;
  if (bytes > MAX_KEY_BYTES) {
    throw new Error(`KV key name is ${bytes} bytes, over the ${MAX_KEY_BYTES} byte limit`);
  }
  return key;
}

export function tarKey(sessionId: string): string {
  return assertKeyFits(`ws:tar:${assertSafeSessionId(sessionId)}`);
}

export function manifestKey(sessionId: string): string {
  return assertKeyFits(`ws:man:${assertSafeSessionId(sessionId)}`);
}

export function workspacePrefix(sessionId: string): string {
  return assertKeyFits(`ws:${assertSafeSessionId(sessionId)}:`);
}

export function isOverSnapshotLimit(bytes: number): boolean {
  return bytes > SNAPSHOT_LIMIT_BYTES;
}

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

// ------------------------------------------------------------------ ports ----

export interface SandboxPort {
  commands: {
    run(
      cmd: string,
      opts?: Record<string, unknown>
    ): Promise<{ stdout: string; stderr?: string; exitCode?: number }>;
  };
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
}

export interface KvPort {
  put(key: string, value: ArrayBuffer, metadata?: Record<string, string>): Promise<void>;
  get(key: string): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
}

// ----------------------------------------------------------------- results ----

export type SnapshotReason =
  | "too_large"
  | "empty"
  | "kv_write_failed"
  | "kv_full"
  | "write_budget"
  | "tar_failed";

export type RestoreReason =
  | "no_snapshot"
  | "not_visible_yet"
  | "size_mismatch"
  | "extract_failed";

export interface ManifestEntry {
  path: string;
  bytes: number;
  /**
   * Always `1970-01-01 00:00` for a snapshot this code made: `--mtime=@0` is what
   * makes the archive byte-reproducible, and a reproducible archive is what makes
   * the sha256 a real "nothing changed" answer instead of one KV write per turn
   * against a 1,000-per-day budget. It is not a timestamp worth showing a person,
   * so the Files tab names the path and the size and leaves this out.
   */
  mtime: string;
}

export interface SnapshotResult {
  ok: boolean;
  reason?: SnapshotReason;
  bytes: number;
  rawBytes?: number;
  files: number;
  limit: number;
  biggest: string[];
  sha256: string | null;
  key: string | null;
  ms: number;
  unchanged?: boolean;
}

export interface RestoreResult {
  ok: boolean;
  restored: boolean;
  reason?: RestoreReason;
  bytes: number;
  files: number;
  expectedBytes?: number;
  attempts?: number;
  ms: number;
  legacy?: boolean;
}

export interface ManifestRecord {
  sessionId: string;
  updatedAt: number;
  bytes: number;
  rawBytes: number;
  filesCount: number;
  sha256: string;
  limit: number;
  truncated: boolean;
  entries: ManifestEntry[];
}

// ---------------------------------------------------------------- commands ----

const EXCLUDES = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  "__pycache__",
];

/**
 * One deterministic gzip tar of the session home. `--sort=name --mtime=@0
 * --numeric-owner` is what makes the sha256 stable, and a stable sha256 is what
 * makes `unchanged` mean "skip this write" instead of "the files moved".
 */
export function buildTarCommand(home: string): string {
  const excludes = EXCLUDES.map((pattern) => `--exclude=${pattern}`).join(" ");
  return (
    `cd ${home} && tar czf ${TAR_PATH} --sort=name --mtime=@0 --numeric-owner ` +
    `--warning=no-file-changed ${excludes} .`
  );
}

/**
 * Parses `tar tzvf` output into path, size, and mtime.
 *
 * The columns are anchored on the timestamp, not counted from the left, because
 * tar prints two different field counts for the same tree. Live against
 * GNU tar 1.34 with `--numeric-owner`:
 *
 *   -rw-r--r-- 1000/1000      5000 1970-01-01 00:00 ./b.txt
 *
 * and with a named owner and a locale month:
 *
 *   -rw-r--r-- user  user      5000 Oct 21  1970 ./b.txt
 *
 * Counting four leading fields works for neither. The size is the run of digits
 * before the date, the mtime is the date plus however many timestamp fields the
 * locale prints, and the member name is the rest of the line taken by offset, so
 * a name containing spaces (`./my  report.txt`) survives. A trailing `/` is a
 * directory, not a file. A line with no date in it is not a member and is
 * dropped rather than guessed at.
 */
export function parseManifest(stdout: string): {
  files: ManifestEntry[];
  truncated: boolean;
  total: number;
  bytesTotal: number;
  biggest: string[];
} {
  const entries: ManifestEntry[] = [];
  for (const line of stdout.split("\n")) {
    const entry = parseListLine(line);
    if (entry) entries.push(entry);
  }
  const total = entries.length;
  const truncated = total > MAX_MANIFEST_ENTRIES;
  return {
    files: truncated ? entries.slice(0, MAX_MANIFEST_ENTRIES) : entries,
    truncated,
    total,
    bytesTotal: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    biggest: topThree(entries),
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^[A-Z][a-z]{2}$/;
const DIGITS = /^\d+$/;

const MODE = /^[-dlscrtbDGpH][-rwxXstST]{9}(?:\+.*)?$/;

function parseListLine(line: string): ManifestEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const fields: Array<{ text: string; at: number }> = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    const start = i;
    while (i < line.length && !/\s/.test(line[i])) i++;
    if (start < i) fields.push({ text: line.slice(start, i), at: start });
  }
  if (!MODE.test(fields[0]?.text ?? "")) return null;
  let dateAt = -1;
  let stampFields = 0;
  for (let f = 1; f < fields.length - 1; f++) {
    const prev = fields[f - 1].text;
    if (!DIGITS.test(prev)) continue;
    if (ISO_DATE.test(fields[f].text)) {
      dateAt = f;
      stampFields = 2;
      break;
    }
    if (MONTH.test(fields[f].text) && DIGITS.test(fields[f + 1].text)) {
      dateAt = f;
      stampFields = 3;
      break;
    }
  }
  if (dateAt < 1) return null;
  const size = Number(fields[dateAt - 1].text);
  const nameAt = fields[dateAt + stampFields];
  if (!nameAt) return null;
  const raw = line.slice(nameAt.at).replace(/\s+$/, "");
  if (!raw || raw.endsWith("/")) return null;
  const mtime = fields
    .slice(dateAt, dateAt + stampFields)
    .map((field) => field.text)
    .join(" ");
  return { path: raw.replace(/^\.\//, ""), bytes: size, mtime };
}

function topThree(entries: ManifestEntry[]): string[] {
  return [...entries]
    .sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : 1))
    .slice(0, 3)
    .map((entry) => entry.path);
}

// --------------------------------------------------------------- measuring ----

export interface Measurement {
  bytes: number;
  rawBytes: number;
  files: number;
  sha256: string;
  biggest: string[];
  entries: ManifestEntry[];
  truncated: boolean;
}

/**
 * Runs the tar and reads back everything the gate and the copy need. Throws if
 * the tar itself fails, because a missing number is worse than a wrong one.
 */
export async function measureSnapshot(sandbox: SandboxPort, home: string): Promise<Measurement> {
  const packed = await sandbox.commands.run(buildTarCommand(home), { timeoutMs: TAR_TIMEOUT_MS });
  if ((packed.exitCode ?? 0) !== 0) {
    throw new Error(`tar failed (exit ${packed.exitCode}): ${oneLine(packed.stderr)}`);
  }

  const stat = await sandbox.commands.run(`stat -c %s ${TAR_PATH}`, {
    timeoutMs: STAT_TIMEOUT_MS,
  });
  const bytes = Number(oneLine(stat.stdout));
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new Error(`tar failed: could not read the size of ${TAR_PATH}`);
  }

  const hashed = await sandbox.commands.run(`sha256sum ${TAR_PATH}`, {
    timeoutMs: STAT_TIMEOUT_MS,
  });
  const sha256 = (hashed.stdout.match(/^[0-9a-f]{64}/m) ?? [""])[0];
  if (!sha256) {
    throw new Error(`tar failed: sha256sum returned ${JSON.stringify(oneLine(hashed.stdout))}`);
  }

  const listed = await sandbox.commands.run(`tar tzvf ${TAR_PATH}`, {
    timeoutMs: TAR_TIMEOUT_MS,
  });
  const parsed = parseManifest(listed.stdout);
  return {
    bytes,
    rawBytes: parsed.bytesTotal,
    files: parsed.total,
    sha256,
    biggest: parsed.biggest,
    entries: parsed.files,
    truncated: parsed.truncated,
  };
}

// ---------------------------------------------------------------- snapshot ----

export interface SnapshotOptions {
  priorSha256?: string;
  home?: string;
}

/**
 * Build, measure, and only then store. `too_large` and `empty` write nothing and
 * delete nothing, so the copy a session already has is never traded for a turn
 * that produced less than the limit or nothing at all.
 */
export async function snapshot(
  sandbox: SandboxPort,
  kv: KvPort,
  sessionId: string,
  opts: SnapshotOptions = {}
): Promise<SnapshotResult> {
  const key = tarKey(sessionId);
  const home = opts.home ?? DEFAULT_HOME;
  const started = Date.now();
  const empty = {
    bytes: 0,
    files: 0,
    limit: SNAPSHOT_LIMIT_BYTES,
    biggest: [] as string[],
    sha256: null as string | null,
    key: null as string | null,
  };

  let measured: Measurement;
  try {
    measured = await measureSnapshot(sandbox, home);
  } catch {
    return { ...empty, ok: false, reason: "tar_failed", ms: Date.now() - started };
  }

  const shape = {
    bytes: measured.bytes,
    rawBytes: measured.rawBytes,
    files: measured.files,
    limit: SNAPSHOT_LIMIT_BYTES,
    biggest: measured.biggest,
    sha256: measured.sha256 as string | null,
    key: null as string | null,
  };

  // The size gate reads `stat`, which does not depend on parsing the listing, so
  // it runs first: an over-limit workspace is refused for the true reason even
  // when the manifest came back short.
  if (isOverSnapshotLimit(measured.bytes)) {
    return { ...shape, ok: false, reason: "too_large", ms: Date.now() - started };
  }

  if (opts.priorSha256 && opts.priorSha256 === measured.sha256) {
    return { ...shape, key, ok: true, unchanged: true, ms: Date.now() - started };
  }

  if (measured.files === 0) {
    return { ...shape, ok: true, reason: "empty", ms: Date.now() - started };
  }

  const data = await sandbox.readFile(TAR_PATH);
  const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const record: ManifestRecord = {
    sessionId,
    updatedAt: Date.now(),
    bytes: measured.bytes,
    rawBytes: measured.rawBytes,
    filesCount: measured.files,
    sha256: measured.sha256,
    limit: SNAPSHOT_LIMIT_BYTES,
    truncated: measured.truncated,
    entries: measured.entries,
  };
  const manifest = new TextEncoder().encode(JSON.stringify(record));

  try {
    await kv.put(key, body, {
      sha256: measured.sha256,
      bytes: String(measured.bytes),
      files: String(measured.files),
    });
    await kv.put(manifestKey(sessionId), manifest.buffer.slice(
      manifest.byteOffset,
      manifest.byteOffset + manifest.byteLength
    ) as ArrayBuffer, { sha256: measured.sha256 });
  } catch (err) {
    return {
      ...shape,
      ok: false,
      // `err` is unknown (strict catch typing); `err.message` does not exist on
      // it, and narrowing `err &&` alone leaves `{}`. Read the message only from
      // an object that actually carries one, then classify the text.
      reason: classifyKvWriteError(
        String(err && typeof err === "object" && "message" in err ? err.message : err)
      ),
      ms: Date.now() - started,
    };
  }

  return { ...shape, key, ok: true, unchanged: false, ms: Date.now() - started };
}

/**
 * Cloudflare's KV write rejections are matched on words in the message, not on
 * error codes, because nothing about this design depends on the match being
 * exhaustive: every branch preserves the stored copy and names the measured
 * size, and `kv_write_failed` is the catch-all that still tells the truth.
 */
function classifyKvWriteError(message: string): SnapshotReason {
  const text = message.toLowerCase();
  if (text.includes("capacity") || text.includes("allotted") || text.includes("full")) {
    return "kv_full";
  }
  if (text.includes("write") && text.includes("exceed")) return "write_budget";
  return "kv_write_failed";
}

// ----------------------------------------------------------------- restore ----

export interface RestoreOptions {
  home?: string;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Three answers the shipped code used to swallow into one catch: nothing was
 * ever saved (`no_snapshot`, normal), the pointer says bytes exist but this
 * location has not replicated them (`not_visible_yet`), and the bytes are there
 * but the archive will not unpack (`extract_failed`). Only the second and third
 * are retried or reported as failures, and none of them may boot an empty
 * workspace and call it a restore.
 */
export async function restore(
  sandbox: SandboxPort,
  kv: KvPort,
  sessionId: string,
  expected?: { bytes: number; sha256?: string },
  opts: RestoreOptions = {}
): Promise<RestoreResult> {
  const key = tarKey(sessionId);
  const home = opts.home ?? DEFAULT_HOME;
  const started = Date.now();
  const maxAttempts = opts.attempts ?? RESTORE_ATTEMPTS;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let body: ArrayBuffer | null = null;
  let observed = 0;
  let reason: RestoreReason = "not_visible_yet";
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    const got = await kv.get(key);
    if (got) {
      observed = got.byteLength;
      if (expected && expected.bytes > 0 && got.byteLength < expected.bytes) {
        reason = "size_mismatch";
      } else {
        body = got;
        break;
      }
    } else if (!expected || expected.bytes <= 0) {
      return {
        ok: true,
        restored: false,
        reason: "no_snapshot",
        bytes: 0,
        files: 0,
        attempts: attempt,
        ms: Date.now() - started,
      };
    } else {
      reason = "not_visible_yet";
    }
    if (attempt < maxAttempts) await sleep(RETRY_BASE_MS * attempt);
  }

  if (!body) {
    return {
      ok: false,
      restored: false,
      reason,
      bytes: observed,
      files: 0,
      expectedBytes: expected ? expected.bytes : undefined,
      attempts,
      ms: Date.now() - started,
    };
  }

  const head = new Uint8Array(body, 0, 2);
  const legacy = !(head[0] === 0x1f && head[1] === 0x8b);

  const command = legacy
    ? `cd ${home} && base64 -d ${B64_PATH} | tar xzf -`
    : `cd ${home} && tar xzf ${TAR_PATH}`;
  await sandbox.writeFile(legacy ? B64_PATH : TAR_PATH, new Uint8Array(body));
  const extracted = await sandbox.commands.run(command, { timeoutMs: TAR_TIMEOUT_MS });

  if ((extracted.exitCode ?? 0) !== 0) {
    return {
      ok: false,
      restored: false,
      reason: "extract_failed",
      bytes: observed,
      files: 0,
      expectedBytes: expected ? expected.bytes : undefined,
      attempts,
      ms: Date.now() - started,
    };
  }

  // A base64 snapshot predates the manifest key, and a manifest written by the
  // old code would describe a different payload, so nothing is claimed about the
  // file count in that branch.
  let files = 0;
  if (!legacy) {
    const raw = await kv.get(manifestKey(sessionId));
    if (raw) {
      try {
        const record = JSON.parse(new TextDecoder().decode(raw)) as Partial<ManifestRecord>;
        if (typeof record.filesCount === "number") files = record.filesCount;
      } catch {
        files = 0;
      }
    }
  }

  return {
    ok: true,
    restored: true,
    bytes: observed,
    files,
    expectedBytes: expected ? expected.bytes : undefined,
    attempts,
    ms: Date.now() - started,
    legacy,
  };
}

// ------------------------------------------------------ reading and removing ----

export async function readArchive(
  kv: KvPort,
  sessionId: string
): Promise<{ bytes: number; body: ArrayBuffer } | null> {
  const body = await kv.get(tarKey(sessionId));
  if (!body) return null;
  return { bytes: body.byteLength, body };
}

export async function readManifestRecord(
  kv: KvPort,
  sessionId: string
): Promise<ManifestRecord | null> {
  const raw = await kv.get(manifestKey(sessionId));
  if (!raw) return null;
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as ManifestRecord;
  } catch {
    return null;
  }
}

/** Derived names only. `list()` costs one of the 1,000 daily list requests and is eventually consistent anyway. */
export async function dropWorkspace(kv: KvPort, sessionId: string): Promise<{ deleted: string[] }> {
  const keys = [tarKey(sessionId), manifestKey(sessionId)];
  for (const key of keys) await kv.delete(key);
  return { deleted: keys };
}

function oneLine(text: string | undefined): string {
  return (text ?? "").trim().split("\n")[0] ?? "";
}
