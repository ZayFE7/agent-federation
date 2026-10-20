// zay-sandbox: E2B microVM command runner on the official SDK
// (edge-compatible, HTTP envd data plane). Warm session pool via KV.

import { Sandbox } from "e2b";

interface Env {
  E2B_API_KEY: string;
  SBOX_TOKEN: string;
  SESSIONS: KVNamespace;
}

const BOOT_TIMEOUT_MS = 300_000; // 5 min lease
const POOL_TTL = 600; // reuse window seconds
// Mirrors src/capabilities.ts: this worker builds separately and cannot import
// from the brain's src/. tests/paths.test.mjs pins that both say /home/user.
const SANDBOX_HOME = "/home/user";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function createSandbox(key: string): Promise<Sandbox> {
  return Sandbox.create({
    apiKey: key,
    template: "base",
    timeoutMs: BOOT_TIMEOUT_MS,
  });
}

async function poolGet(env: Env, sessionId: string): Promise<Sandbox> {
  const hit = (await env.SESSIONS.get(sessionId, "json")) as { id: string } | null;
  if (hit?.id) {
    try {
      return await Sandbox.connect(hit.id, { apiKey: env.E2B_API_KEY });
    } catch {
      await env.SESSIONS.delete(sessionId);
    }
  }
  const sbx = await createSandbox(env.E2B_API_KEY);
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
  // Persistent workspaces: restore the last snapshot into the home dir on a
  // fresh boot. The home dir always exists, so no mkdir.
  try {
    const tar = await env.SESSIONS.get(`ws:tar:${sessionId}`);
    if (tar) {
      await sbx.commands.run(
        `cd ${SANDBOX_HOME} && echo '` + tar + `' | base64 -d | tar xzf -`,
        { timeoutMs: 30_000 }
      );
    }
  } catch {
    /* no snapshot yet */
  }
  await env.SESSIONS.put(
    sessionId,
    JSON.stringify({ id: sbx.sandboxId }),
    { expirationTtl: POOL_TTL }
  );
  return sbx;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("authorization") !== `Bearer ${env.SBOX_TOKEN}`) {
      return json(401, { error: "unauthorized" });
    }

    if (url.pathname === "/health") {
      return json(200, { ok: true, service: "zay-sandbox" });
    }

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
      const body = (await request.json()) as { sessionId?: string };
      const sid = body.sessionId || "agent";
      let sbx: Sandbox;
      try {
        sbx = await poolGet(env, sid);
      } catch (e) {
        return json(502, { error: String(e) });
      }
      const packed = await sbx.commands.run(
        `cd ${SANDBOX_HOME} && tar czf - . 2>/dev/null | base64 -w0`,
        { timeoutMs: 30_000 }
      );
      const b64 = (packed.stdout || "").trim();
      if (!b64) return json(200, { ok: true, bytes: 0, note: "home directory empty" });
      await env.SESSIONS.put(`ws:tar:${sid}`, b64);
      return json(200, { ok: true, bytes: Math.floor((b64.length * 3) / 4), sessionId: sid });
    }

    if (url.pathname === "/run" && request.method === "POST") {
      const body = (await request.json()) as { cmd?: string; sessionId?: string };
      if (!body.cmd) return json(400, { error: "cmd required" });
      const sid = body.sessionId || "default";
      let sbx: Sandbox;
      try {
        sbx = await poolGet(env, sid);
      } catch (e) {
        return json(502, { error: "boot: " + String(e) });
      }
      const keepWarm = () =>
        env.SESSIONS.put(sid, JSON.stringify({ id: sbx.sandboxId }), {
          expirationTtl: POOL_TTL,
        });
      // onError swallows the throw on non-zero exit so we can return the real
      // stdout/stderr/exitCode. A command that fails is data, not a worker error.
      try {
        const result = await sbx.commands.run(body.cmd, {
          timeoutMs: 60_000,
          cwd: SANDBOX_HOME,
          onError: () => {},
        });
        await keepWarm();
        return json(200, {
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          exitCode: result.exitCode ?? 0,
          sessionId: sid,
          sandboxId: sbx.sandboxId,
        });
      } catch (e) {
        const err = e as { exitCode?: number; stdout?: string; stderr?: string };
        if (
          typeof err.exitCode === "number" ||
          err.stdout !== undefined ||
          err.stderr !== undefined
        ) {
          await keepWarm();
          return json(200, {
            stdout: err.stdout ?? "",
            stderr: err.stderr ?? "",
            exitCode: err.exitCode ?? 1,
            sessionId: sid,
            sandboxId: sbx.sandboxId,
          });
        }
        return json(502, {
          error: "run: " + String(e),
          sessionId: sid,
          sandboxId: sbx.sandboxId,
        });
      }
    }

    return json(404, { error: "not found" });
  },
} satisfies ExportedHandler<Env>;
