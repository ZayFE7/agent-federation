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
      try {
        const result = await sbx.commands.run(body.cmd, { timeout: 60 });
        // keep lease warm
        await env.SESSIONS.put(
          sid,
          JSON.stringify({ id: sbx.sandboxId }),
          { expirationTtl: POOL_TTL }
        );
        return json(200, {
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          exitCode: result.exitCode ?? 0,
          sessionId: sid,
          sandboxId: sbx.sandboxId,
        });
      } catch (e) {
        return json(500, { error: String(e), sessionId: sid, sandboxId: sbx.sandboxId });
      }
    }

    return json(404, { error: "not found" });
  },
} satisfies ExportedHandler<Env>;
