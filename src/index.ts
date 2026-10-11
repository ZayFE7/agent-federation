import { FederationAgent } from "./agent";
import type { AgentReply, ChatRequest, ChatTier, Env } from "./types";

export { FederationAgent };

/** Minimal RPC surface of FederationAgent used over the DO stub. */
interface AgentStub {
  chat(content: string, tier?: ChatTier): Promise<AgentReply>;
  vaultPut(key: string, idx: number, total: number, dataB64: string): Promise<void>;
  vaultPull(key: string): Promise<Uint8Array | null>;
  vaultChunk(key: string, idx: number): Promise<string | null>;
  vaultHealth(key: string): Promise<Record<string, unknown> | null>;
  vaultDelete(key: string): Promise<void>;
}

function mainAgentId(env: Env): DurableObjectId {
  return env.FEDERATION_AGENT.idFromName("main");
}

function agentStub(env: Env): AgentStub {
  const stub = env.FEDERATION_AGENT.get(mainAgentId(env));
  // Cast avoids depending on version-specific DurableObjectNamespace generics.
  return stub as unknown as AgentStub;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrades (path /) go straight to the agent DO; the Agents SDK
    // performs the hibernation handshake and dispatches frames to onMessage.
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const stub = env.FEDERATION_AGENT.get(mainAgentId(env));
      return stub.fetch(request);
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/api/message" && request.method === "POST") {
      const auth = request.headers.get("Authorization") ?? "";
      if (auth !== `Bearer ${env.AGENT_API_KEY}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      let body: ChatRequest;
      try {
        body = (await request.json()) as ChatRequest;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (typeof body?.content !== "string" || body.content.length === 0) {
        return Response.json({ error: "content required" }, { status: 400 });
      }
      const tier: ChatTier | undefined =
        body.tier === "primary" || body.tier === "cheap" ? body.tier : undefined;
      const result = await agentStub(env).chat(body.content, tier);
      return Response.json(result);
    }

    // ---- State vault (9router container sync) ----
    const vaultAuthed =
      request.headers.get("Authorization") === `Bearer ${env.STATE_KEY}` &&
      env.STATE_KEY.length > 0;

    if (url.pathname === "/internal/vault/push" && request.method === "POST") {
      if (!vaultAuthed) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      let body: { key?: string; idx?: number; total?: number; dataB64?: string };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (
        typeof body.key !== "string" ||
        body.key.length === 0 ||
        !Number.isInteger(body.idx) ||
        !Number.isInteger(body.total) ||
        typeof body.dataB64 !== "string"
      ) {
        return Response.json({ error: "key, idx, total, dataB64 required" }, { status: 400 });
      }
      await agentStub(env).vaultPut(body.key, Number(body.idx), Number(body.total), body.dataB64);
      return Response.json({ ok: true, idx: body.idx, total: body.total });
    }

    if (url.pathname === "/internal/vault/chunk" && request.method === "GET") {
      if (!vaultAuthed) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const key = url.searchParams.get("key");
      const idx = Number(url.searchParams.get("idx"));
      if (!key || !Number.isInteger(idx)) {
        return Response.json({ error: "key and idx required" }, { status: 400 });
      }
      const meta = await agentStub(env).vaultHealth(key);
      if (!meta) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      const b64 = await agentStub(env).vaultChunk(key, idx);
      if (b64 === null) {
        return Response.json({ error: "chunk not found" }, { status: 404 });
      }
      return new Response(b64, {
        headers: { "content-type": "text/plain", "x-vault-total": String(meta["total"] ?? "") },
      });
    }

    if (url.pathname === "/internal/vault/pull" && request.method === "GET") {
      if (!vaultAuthed) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const key = url.searchParams.get("key");
      if (!key) {
        return Response.json({ error: "key required" }, { status: 400 });
      }
      const bytes = await agentStub(env).vaultPull(key);
      if (!bytes) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      return new Response(bytes as unknown as BodyInit, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(bytes.length),
        },
      });
    }

    if (url.pathname === "/internal/vault/health" && request.method === "GET") {
      if (!vaultAuthed) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const key = url.searchParams.get("key");
      if (!key) {
        return Response.json({ error: "key required" }, { status: 400 });
      }
      const meta = await agentStub(env).vaultHealth(key);
      return Response.json(meta ?? { ok: false, key });
    }

    if (url.pathname === "/internal/vault" && request.method === "DELETE") {
      if (!vaultAuthed) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const key = url.searchParams.get("key");
      if (!key) {
        return Response.json({ error: "key required" }, { status: 400 });
      }
      await agentStub(env).vaultDelete(key);
      return Response.json({ ok: true });
    }

    // Everything else: the console UI (static assets).
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },

  /** Keep-alive cron: ping the Render 9router every 10 min so free tier never idles. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    if (!env.RENDER_URL) return;
    try {
      const res = await fetch(`${env.RENDER_URL.replace(/\/+$/, "")}/health`, {
        cf: { cacheTtl: 0 },
      });
      console.log(`keep-alive: ${res.status}`);
    } catch (err) {
      console.log(`keep-alive failed: ${String(err)}`);
    }
  },
} satisfies ExportedHandler<Env>;
