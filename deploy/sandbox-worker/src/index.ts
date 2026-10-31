// zay-sandbox: E2B microVM command runner on the official SDK
// (edge-compatible, HTTP envd data plane). Warm session pool via KV, capped and
// idle-collected by the policy in ../pool.ts.
//
// Workspace snapshots live here too: one measured gzip tar per session in the
// SESSIONS namespace, the logic in ../workspace.ts, which this file adapts to the
// real SDK. This worker runs arbitrary shell, so the bearer gate fails closed:
// an unset SBOX_TOKEN must 401 every route rather than compare against the
// literal string "Bearer undefined".

import { Sandbox } from "e2b";
import { authed } from "../auth";
import {
  LEASE_MS,
  POOL_APP_KEY,
  POOL_APP_VALUE,
  POOL_SESSION_KEY,
  POOL_TTL_SECONDS,
  pickEviction,
  toLive,
} from "../pool";
import {
  assertSafeSessionId,
  dropWorkspace,
  manifestKey,
  readArchive,
  readManifestRecord,
  restore,
  snapshot,
  tarKey,
  type KvPort,
  type SandboxPort,
} from "../workspace";
import type { RestoreResult } from "../workspace";

interface Env {
  E2B_API_KEY: string;
  SBOX_TOKEN: string;
  SESSIONS: KVNamespace;
}

// The lease and the pool row's lifetime come from ../pool.ts, because the eviction
// policy reads recency out of the lease and the two must not drift apart here.
// Mirrors src/capabilities.ts: this worker builds separately and cannot import
// from the brain's src/. tests/paths.test.mjs pins that both say /home/user.
const SANDBOX_HOME = "/home/user";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// A skill package path is data from the registry, but this route still refuses
// anything that could climb out of the home directory or name an unusual file.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function safeRelative(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 300) return null;
  const clean = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = clean.split("/");
  if (parts.length === 0) return null;
  for (const part of parts) {
    if (!part || part === "." || part === ".." || !SAFE_SEGMENT.test(part)) return null;
  }
  return parts.join("/");
}

/**
 * A workspace path for reads. Wider than a skill path on purpose: a user's file
 * may carry a space or a non-ASCII name, and those are legal Linux names. The
 * guard still refuses absolute paths, empty segments, dots and controls.
 */
function safeHomePath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 500) return null;
  if (raw.startsWith("/") || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'";
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

function mimeFor(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "application/octet-stream" : MIME[base.slice(dot)] || "application/octet-stream";
}

// The KV namespace holds two kinds of value: the pool rows (JSON strings, keyed
// by bare session id) and the workspace archives (raw ArrayBuffers, keyed
// ws:tar:<id> / ws:man:<id>). Only the second goes through this port, which is
// why get is pinned to "arrayBuffer" rather than the default text.
function kvPort(ns: KVNamespace): KvPort {
  return {
    async put(key, value, metadata) {
      await ns.put(key, value, metadata ? { metadata } : undefined);
    },
    async get(key) {
      return (await ns.get(key, "arrayBuffer")) ?? null;
    },
    async delete(key) {
      await ns.delete(key);
    },
  };
}

type RunOpts = Parameters<Sandbox["commands"]["run"]>[1];

function sandboxPort(sbx: Sandbox): SandboxPort {
  return {
    commands: {
      run: async (cmd, opts) => {
        const r = await sbx.commands.run(cmd, opts as RunOpts);
        return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
      },
    },
    // Pinned against e2b@1.13.2 dist/index.d.ts: read(path, {format:"bytes"})
    // is the method that yields a Uint8Array, and write takes one.
    readFile: (path) => sbx.files.read(path, { format: "bytes" }),
    writeFile: async (path, data) => {
      await sbx.files.write(path, data);
    },
  };
}

async function createSandbox(key: string, sessionId: string): Promise<Sandbox> {
  return Sandbox.create({
    apiKey: key,
    template: "base",
    timeoutMs: LEASE_MS,
    // The tag is how a later request, possibly in another isolate, finds this VM
    // again and knows which session to blame for it. An untagged VM is never
    // evicted, so a typo here disables the cap quietly rather than loudly.
    metadata: { [POOL_APP_KEY]: POOL_APP_VALUE, [POOL_SESSION_KEY]: sessionId },
  });
}

async function keepWarm(env: Env, sessionId: string, sandboxId: string): Promise<void> {
  await env.SESSIONS.put(sessionId, JSON.stringify({ id: sandboxId }), {
    expirationTtl: POOL_TTL_SECONDS,
  });
}

export type Eviction = { sessionId: string; sandboxId: string; saved: boolean };

/**
 * Stay inside MAX_LIVE_SANDBOXES before a new VM is created.
 *
 * The victim is snapshotted before it is killed. Task 27 made a session's files
 * survive the death of its VM, and a cap that destroyed work would be worse than no
 * cap, so an eviction costs two KV writes and says so. If the save fails the kill
 * still happens, because the quota bound is the whole point, and the result carries
 * `saved: false` rather than letting the caller infer success from a 200.
 *
 * A failed `list` returns null and lets the request create its VM uncapped. The cap
 * is worth less than turning a user's command into a 502 because a management API
 * had a bad second.
 */
async function makeRoom(env: Env, requested: string): Promise<Eviction | null> {
  let rows: Awaited<ReturnType<typeof Sandbox.list>>;
  try {
    rows = await Sandbox.list({
      apiKey: env.E2B_API_KEY,
      query: { metadata: { [POOL_APP_KEY]: POOL_APP_VALUE } },
    });
  } catch (e) {
    console.warn(`pool: list failed, creating uncapped: ${String(e)}`);
    return null;
  }

  const victim = pickEviction(toLive(rows), requested);
  if (!victim) return null;

  const ids = new Map<string, string>();
  for (const r of rows) {
    const owner = r.metadata?.[POOL_SESSION_KEY];
    if (owner && r.sandboxId) ids.set(owner, r.sandboxId);
  }
  const sandboxId = ids.get(victim);
  if (!sandboxId) return null;

  let saved = false;
  try {
    const sbx = await Sandbox.connect(sandboxId, { apiKey: env.E2B_API_KEY });
    const r = await snapshot(sandboxPort(sbx), kvPort(env.SESSIONS), victim, {
      home: SANDBOX_HOME,
    });
    saved = r.ok;
  } catch (e) {
    console.warn(`pool: evicting ${victim} without a save: ${String(e)}`);
  }
  try {
    await Sandbox.kill(sandboxId, { apiKey: env.E2B_API_KEY });
  } catch (e) {
    // The VM is the thing being reclaimed. If the kill throws the quota is not
    // reclaimed, so this must be visible in the tail rather than swallowed.
    console.warn(`pool: kill failed for ${victim} (${sandboxId}): ${String(e)}`);
  }
  await env.SESSIONS.delete(victim);
  return { sessionId: victim, sandboxId, saved };
}

/**
 * Return a live sandbox for the session, restoring its saved workspace only when
 * this is a fresh boot. The old code ran the restore inside `try { } catch { }`
 * and called every failure an absent snapshot, so a truncated archive or a KV
 * read that had not replicated yet looked exactly like a session nobody ever
 * saved. The outcome travels back to the caller instead.
 */
async function boot(
  env: Env,
  sessionId: string
): Promise<{ sbx: Sandbox; restored: RestoreResult | null; evicted: Eviction | null }> {
  const hit = (await env.SESSIONS.get(sessionId, "json")) as { id: string } | null;
  if (hit?.id) {
    try {
      const sbx = await Sandbox.connect(hit.id, { apiKey: env.E2B_API_KEY });
      // Extending the lease on every reuse is what makes the lease double as the
      // idle collector: a busy session keeps its VM, an abandoned one expires in
      // LEASE_MS with no GC to run. If the extension itself fails the VM simply
      // dies on the lease it already has, and the next request cold-boots and
      // restores, so this is not allowed to fail the run.
      await sbx.setTimeout(LEASE_MS).catch((e: unknown) =>
        console.warn(`pool: lease extension failed for ${sessionId}: ${String(e)}`)
      );
      return { sbx, restored: null, evicted: null };
    } catch {
      await env.SESSIONS.delete(sessionId);
    }
  }
  const evicted = await makeRoom(env, sessionId);
  const sbx = await createSandbox(env.E2B_API_KEY, sessionId);
  // E2B "base" ships python3 but no `python` alias; the model reaches for
  // `python` and gets exit 127. Create the alias once per fresh boot.
  try {
    await sbx.commands.run(
      'ln -sf "$(command -v python3)" /usr/local/bin/python 2>/dev/null || true',
      { timeoutMs: 15_000, onError: () => {} }
    );
  } catch {
    /* non-fatal: alias is best-effort */
  }
  // The home dir always exists, so nothing is mkdir'd. A snapshot that cannot be
  // restored is reported, never repaired by silently handing the session an
  // empty directory.
  const kv = kvPort(env.SESSIONS);
  const pointer = await readManifestRecord(kv, sessionId);
  const restored = await restore(
    sandboxPort(sbx),
    kv,
    sessionId,
    pointer ? { bytes: pointer.bytes, sha256: pointer.sha256 } : undefined,
    { home: SANDBOX_HOME }
  );
  await keepWarm(env, sessionId, sbx.sandboxId);
  return { sbx, restored, evicted };
}

function snapshotStatus(r: { ok: boolean; reason?: string }): number {
  if (r.ok) return 200;
  switch (r.reason) {
    case "too_large":
      return 413;
    case "empty":
      return 200;
    case "kv_full":
      return 503;
    case "write_budget":
      return 429;
    default:
      return 502;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!authed(request.headers.get("authorization"), env.SBOX_TOKEN)) {
      return json(401, { error: "unauthorized" });
    }

    if (url.pathname === "/health") {
      return json(200, { ok: true, service: "zay-sandbox" });
    }

    // Killing a VM is not deleting a user's files: this route touches the pool
    // row and nothing else.
    if (url.pathname === "/session/kill" && request.method === "POST") {
      const body = (await request.json()) as { sessionId?: string };
      const sid = body.sessionId || "default";
      const hit = (await env.SESSIONS.get(sid, "json")) as { id: string } | null;
      if (hit?.id) {
        try {
          const sbx = await Sandbox.connect(hit.id, { apiKey: env.E2B_API_KEY });
          await sbx.kill();
        } catch {
          /* already dead */
        }
        await env.SESSIONS.delete(sid);
      }
      return json(200, { ok: true });
    }

    if (url.pathname === "/workspace/snapshot" && request.method === "POST") {
      const body = (await request.json()) as { sessionId?: string; priorSha256?: string };
      const sid = body.sessionId || "default";
      let sbx: Sandbox;
      try {
        sbx = (await boot(env, sid)).sbx;
      } catch (e) {
        return json(502, { error: "boot: " + String(e) });
      }
      const r = await snapshot(sandboxPort(sbx), kvPort(env.SESSIONS), sid, {
        priorSha256: body.priorSha256,
        home: SANDBOX_HOME,
      });
      await keepWarm(env, sid, sbx.sandboxId);
      return json(snapshotStatus(r), r);
    }

    if (url.pathname === "/workspace/restore" && request.method === "POST") {
      const body = (await request.json()) as { sessionId?: string; expectedBytes?: number };
      const sid = body.sessionId || "default";
      const kv = kvPort(env.SESSIONS);
      let sbx: Sandbox;
      let r: RestoreResult;
      try {
        const booted = await boot(env, sid);
        sbx = booted.sbx;
        // A fresh boot already restored; a warm one has not been touched since it
        // came up, so an explicit call here is what re-reads a snapshot that has
        // only now replicated.
        r =
          booted.restored ??
          (await restore(
            sandboxPort(sbx),
            kv,
            sid,
            body.expectedBytes ? { bytes: body.expectedBytes } : undefined,
            { home: SANDBOX_HOME }
          ));
      } catch (e) {
        return json(502, { error: "boot: " + String(e) });
      }
      await keepWarm(env, sid, sbx.sandboxId);
      return json(r.ok ? 200 : r.reason === "extract_failed" ? 500 : 409, { ...r, sessionId: sid });
    }

    if (url.pathname === "/workspace/copy" && request.method === "POST") {
      let body: { from?: string; to?: string };
      try {
        body = (await request.json()) as { from?: string; to?: string };
        const from = assertSafeSessionId(body.from ?? "");
        const to = assertSafeSessionId(body.to ?? "");
        if (from === to) return json(400, { ok: false, error: "source and target are the same" });
        const kv = env.SESSIONS;
        const archive = await readArchive(kvPort(kv), from);
        if (!archive) return json(404, { ok: false, reason: "no_snapshot", from });
        const manifest = await readManifestRecord(kvPort(kv), from);
        if (!manifest) return json(404, { ok: false, reason: "no_manifest", from });
        await kv.put(tarKey(to), archive.body, { metadata: { bytes: archive.bytes } });
        await kv.put(manifestKey(to), JSON.stringify(manifest));
        return json(200, {
          ok: true,
          from,
          to,
          bytes: archive.bytes,
          files: manifest.filesCount,
          sha256: manifest.sha256,
          entries: manifest.entries,
          truncated: manifest.truncated,
          updatedAt: manifest.updatedAt,
        });
      } catch (e) {
        return json(400, { ok: false, error: String(e).slice(0, 200) });
      }
    }

    if (url.pathname === "/workspace/manifest") {
      const sid = url.searchParams.get("sessionId") || "default";
      const record = await readManifestRecord(kvPort(env.SESSIONS), sid);
      if (!record) {
        return json(404, { ok: false, reason: "no_snapshot", sessionId: sid });
      }
      return json(200, {
        ok: true,
        sessionId: sid,
        files: record.entries,
        truncated: record.truncated,
        bytes: record.bytes,
        rawBytes: record.rawBytes,
        filesCount: record.filesCount,
        updatedAt: record.updatedAt,
        sha256: record.sha256,
      });
    }

    if (url.pathname === "/workspace/archive") {
      const sid = url.searchParams.get("sessionId") || "default";
      const archive = await readArchive(kvPort(env.SESSIONS), sid);
      if (!archive) {
        return json(409, { ok: false, reason: "no_snapshot", sessionId: sid });
      }
      return new Response(archive.body, {
        headers: {
          "content-type": "application/gzip",
          "content-length": String(archive.bytes),
          "content-disposition": `attachment; filename="workspace-${sid}.tar.gz"`,
        },
      });
    }

    if (url.pathname === "/workspace/forget" && request.method === "POST") {
      const body = (await request.json()) as { sessionId?: string };
      const sid = body.sessionId || "default";
      const r = await dropWorkspace(kvPort(env.SESSIONS), sid);
      return json(200, { ok: true, sessionId: sid, deleted: r.deleted });
    }

    if (url.pathname === "/workspace/write" && request.method === "POST") {
      let body: {
        sessionId?: string;
        dir?: string;
        files?: Array<{ path?: string; contentBase64?: string }>;
      };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json(400, { error: "invalid JSON body" });
      }
      const sid = body.sessionId || "default";
      const dir = safeRelative(body.dir ?? "");
      if (dir === null) return json(400, { error: "invalid dir" });
      const files = Array.isArray(body.files) ? body.files : [];
      if (files.length === 0) return json(400, { error: "files required" });
      if (files.length > 500) return json(413, { error: "too many files" });
      const entries: Array<{ path: string; data: Uint8Array }> = [];
      const dirs = new Set<string>();
      let total = 0;
      for (const file of files) {
        const relative = safeRelative(file?.path);
        if (relative === null) return json(400, { error: "invalid file path" });
        if (typeof file?.contentBase64 !== "string") {
          return json(400, { error: `contentBase64 missing for ${relative}` });
        }
        let data: Uint8Array;
        try {
          data = decodeBase64(file.contentBase64);
        } catch {
          return json(400, { error: `invalid base64 for ${relative}` });
        }
        if (data.length > 2 * 1024 * 1024) {
          return json(413, { error: `${relative} is over 2 MB` });
        }
        total += data.length;
        if (total > 8 * 1024 * 1024) {
          return json(413, { error: "the skill file set is over 8 MB" });
        }
        const path = [SANDBOX_HOME, dir, relative].join("/");
        entries.push({ path, data });
        dirs.add(path.slice(0, path.lastIndexOf("/")));
      }
      let sbx: Sandbox;
      try {
        sbx = (await boot(env, sid)).sbx;
      } catch (e) {
        return json(502, { error: "boot: " + String(e) });
      }
      try {
        await sbx.commands.run(`mkdir -p ${[...dirs].map((d) => `'${d}'`).join(" ")}`, {
          timeoutMs: 20_000,
        });
        // One E2B files.write per batch, not per file: the worker subrequest
        // budget is small and a real skill package can have 100+ files.
        for (let at = 0; at < entries.length; at += 40) {
          await sbx.files.write(
            entries.slice(at, at + 40).map((entry) => ({
              path: entry.path,
              data: new Blob([entry.data]),
            }))
          );
        }
        await keepWarm(env, sid, sbx.sandboxId);
        return json(200, {
          ok: true,
          sessionId: sid,
          dir: [SANDBOX_HOME, dir].join("/"),
          written: entries.length,
          bytes: total,
        });
      } catch (e) {
        return json(500, { error: "write: " + String(e), sessionId: sid });
      }
    }

    if (url.pathname === "/workspace/files" && request.method === "GET") {
      const sid = url.searchParams.get("sessionId") || "default";
      let sbx: Sandbox;
      try {
        sbx = (await boot(env, sid)).sbx;
      } catch (e) {
        return json(502, { error: "boot: " + String(e) });
      }
      try {
        const listed = await sbx.commands.run(
          "find . -type f -not -path './.blip/*' -not -path './.git/*' -not -path './node_modules/*' -not -path './.bash_logout' -not -path './.bashrc' -not -path './.profile' -not -path './.cache/*' -not -path './.config/*' -not -path './.local/*' -not -path './.npm/*' -printf '%T@\\t%s\\t%p\\n' | sort -k1,1nr | head -1001",
          { cwd: SANDBOX_HOME, timeoutMs: 30_000 }
        );
        const lines = String(listed.stdout || "").split("\n").filter(Boolean);
        const files: Array<{ path: string; bytes: number; mtime: number }> = [];
        let bytes = 0;
        for (const line of lines.slice(0, 1000)) {
          const first = line.indexOf("\t");
          const second = line.indexOf("\t", first + 1);
          if (first < 0 || second < 0) continue;
          const mtime = Math.round(Number(line.slice(0, first)) * 1000);
          const size = Number(line.slice(first + 1, second));
          const raw = line.slice(second + 1).replace(/^\.\//, "");
          if (!raw) continue;
          files.push({ path: raw, bytes: Number.isFinite(size) ? size : 0, mtime: Number.isFinite(mtime) ? mtime : 0 });
          bytes += Number.isFinite(size) ? size : 0;
        }
        await keepWarm(env, sid, sbx.sandboxId);
        return json(200, {
          ok: true,
          sessionId: sid,
          files,
          bytes,
          truncated: lines.length > 1000,
        });
      } catch (e) {
        return json(502, { error: "list: " + String(e), sessionId: sid });
      }
    }

    if (url.pathname === "/workspace/put" && request.method === "POST") {
      let body: { sessionId?: string; path?: string; contentBase64?: string };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json(400, { error: "invalid JSON body" });
      }
      const sid = body.sessionId || "default";
      const path = safeHomePath(body.path);
      if (path === null) return json(400, { error: "invalid file path" });
      if (typeof body.contentBase64 !== "string") {
        return json(400, { error: "contentBase64 required" });
      }
      let data: Uint8Array;
      try {
        data = decodeBase64(body.contentBase64);
      } catch {
        return json(400, { error: "invalid base64" });
      }
      if (data.length > 2 * 1024 * 1024) {
        return json(413, { error: "the file is over 2 MB" });
      }
      let sbx: Sandbox;
      try {
        sbx = (await boot(env, sid)).sbx;
      } catch (e) {
        return json(502, { error: "boot: " + String(e) });
      }
      try {
        const full = `${SANDBOX_HOME}/${path}`;
        const parent = full.slice(0, full.lastIndexOf("/"));
        if (parent && parent !== SANDBOX_HOME) {
          await sbx.commands.run(`mkdir -p ${shellQuote(parent)}`, { timeoutMs: 15_000 });
        }
        await sbx.files.write(full, new Blob([data]));
        await keepWarm(env, sid, sbx.sandboxId);
        return json(200, { ok: true, path, bytes: data.length, sessionId: sid });
      } catch (e) {
        return json(500, { error: "put: " + String(e), sessionId: sid });
      }
    }

    if (url.pathname === "/workspace/read" && request.method === "GET") {
      const sid = url.searchParams.get("sessionId") || "default";
      const path = safeHomePath(url.searchParams.get("path"));
      if (path === null) return json(400, { error: "invalid file path" });
      const full = `${SANDBOX_HOME}/${path}`;
      let sbx: Sandbox;
      try {
        sbx = (await boot(env, sid)).sbx;
      } catch (e) {
        return json(502, { error: "boot: " + String(e) });
      }
      try {
        const info = await sbx.files.getInfo(full);
        if (!info || typeof info.size !== "number") return json(404, { error: "not found" });
        if (info.size > 25 * 1024 * 1024) return json(413, { error: "the file is over 25 MB" });
        const data = await sbx.files.read(full, { format: "bytes" });
        await keepWarm(env, sid, sbx.sandboxId);
        const name = path.slice(path.lastIndexOf("/") + 1);
        return new Response(new Blob([data]), {
          headers: {
            "content-type": mimeFor(path),
            "content-length": String(data.length),
            "content-disposition": `attachment; filename="${name}"`,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      } catch (e) {
        return json(404, { error: "read: " + String(e), sessionId: sid });
      }
    }

    if (url.pathname === "/workspace/upload" && request.method === "POST") {
      let body: {
        sessionId?: string;
        files?: Array<{ path?: string; contentBase64?: string }>;
      };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json(400, { error: "invalid JSON body" });
      }
      const sid = body.sessionId || "default";
      const files = Array.isArray(body.files) ? body.files : [];
      if (files.length === 0) return json(400, { error: "files required" });
      if (files.length > 10) return json(413, { error: "too many attachments" });
      const entries: Array<{ path: string; relative: string; data: Uint8Array }> = [];
      const dirs = new Set<string>();
      let total = 0;
      for (const file of files) {
        const relative = safeRelative(file?.path);
        if (relative === null) return json(400, { error: "invalid file path" });
        if (typeof file?.contentBase64 !== "string") {
          return json(400, { error: `contentBase64 missing for ${relative}` });
        }
        let data: Uint8Array;
        try {
          data = decodeBase64(file.contentBase64);
        } catch {
          return json(400, { error: `invalid base64 for ${relative}` });
        }
        if (data.length > 12 * 1024 * 1024) {
          return json(413, { error: `${relative} is over 12 MB` });
        }
        total += data.length;
        if (total > 24 * 1024 * 1024) return json(413, { error: "attachments are over 24 MB" });
        const full = `${SANDBOX_HOME}/${relative}`;
        entries.push({ path: full, relative, data });
        dirs.add(full.slice(0, full.lastIndexOf("/")));
      }
      let sbx: Sandbox;
      try {
        sbx = (await boot(env, sid)).sbx;
      } catch (e) {
        return json(502, { error: "boot: " + String(e) });
      }
      try {
        await sbx.commands.run(`mkdir -p ${[...dirs].map((d) => `'${d}'`).join(" ")}`, {
          timeoutMs: 20_000,
        });
        for (let at = 0; at < entries.length; at += 10) {
          await sbx.files.write(
            entries.slice(at, at + 10).map((entry) => ({
              path: entry.path,
              data: new Blob([entry.data]),
            }))
          );
        }
        await keepWarm(env, sid, sbx.sandboxId);
        return json(200, {
          ok: true,
          sessionId: sid,
          bytes: total,
          files: entries.map((entry) => ({ path: entry.relative, bytes: entry.data.length })),
        });
      } catch (e) {
        return json(500, { error: "upload: " + String(e), sessionId: sid });
      }
    }

    if (url.pathname === "/run" && request.method === "POST") {
      const body = (await request.json()) as { cmd?: string; sessionId?: string };
      if (!body.cmd) return json(400, { error: "cmd required" });
      const sid = body.sessionId || "default";
      let sbx: Sandbox;
      let restored: RestoreResult | null;
      let evicted: Eviction | null;
      try {
        ({ sbx, restored, evicted } = await boot(env, sid));
      } catch (e) {
        return json(502, { error: "boot: " + String(e) });
      }
      // onError swallows the throw on non-zero exit so we can return the real
      // stdout/stderr/exitCode. A command that fails is data, not a worker error.
      try {
        const result = await sbx.commands.run(body.cmd, {
          timeoutMs: 60_000,
          cwd: SANDBOX_HOME,
          onError: () => {},
        });
        await keepWarm(env, sid, sbx.sandboxId);
        return json(200, {
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          exitCode: result.exitCode ?? 0,
          sessionId: sid,
          sandboxId: sbx.sandboxId,
          restore: restored,
          evict: evicted,
        });
      } catch (e) {
        const err = e as { exitCode?: number; stdout?: string; stderr?: string };
        if (
          typeof err.exitCode === "number" ||
          err.stdout !== undefined ||
          err.stderr !== undefined
        ) {
          await keepWarm(env, sid, sbx.sandboxId);
          return json(200, {
            stdout: err.stdout ?? "",
            stderr: err.stderr ?? "",
            exitCode: err.exitCode ?? 1,
            sessionId: sid,
            sandboxId: sbx.sandboxId,
            restore: restored,
            evict: evicted,
          });
        }
        return json(502, {
          error: "run: " + String(e),
          sessionId: sid,
          sandboxId: sbx.sandboxId,
          restore: restored,
          evict: evicted,
        });
      }
    }

    return json(404, { error: "not found" });
  },
} satisfies ExportedHandler<Env>;
