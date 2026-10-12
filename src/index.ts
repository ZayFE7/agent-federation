import { FederationAgent } from "./agent";
import type { AgentReply, ChatRequest, ChatTier, Env } from "./types";

export { FederationAgent };

/** Minimal RPC surface of FederationAgent used over the DO stub. */
interface AgentStub {
  chat(content: string, tier?: ChatTier): Promise<AgentReply>;
  jobList(): Promise<unknown[]>;
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
      const auth = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (auth !== env.AGENT_API_KEY.trim()) {
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

    if (url.pathname === "/api/tasks" && request.method === "GET") {
      const auth = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (auth !== env.AGENT_API_KEY.trim()) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const list = await agentStub(env).jobList();
      return Response.json({ ok: true, tasks: list });
    }

    if (url.pathname === "/api/decide" && request.method === "POST") {
      if (request.headers.get("Authorization") !== `Bearer ${env.AGENT_API_KEY}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      let body: { context?: string };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (typeof body.context !== "string" || !body.context) {
        return Response.json({ error: "context required" }, { status: 400 });
      }
      // TEMP debug: expose the exact router URL the brain holds
      if (body.context === "__debug_url") {
        const origin = env.ROUTER_URL.replace(/\/v1\/.*$/, "");
        let probe = "no probe";
        try {
          const pr = await fetch(origin + "/health");
          probe = pr.status + " " + (await pr.text()).slice(0, 120);
        } catch (e) {
          probe = String(e);
        }
        return Response.json({ routerUrl: env.ROUTER_URL, origin, probe, hasKey: !!env.ROUTER_KEY, keyLen: (env.ROUTER_KEY || "").length });
      }
      const states = [
        "idle","think","browse","search","read","code","mail","pay",
        "approve","success","error","sleep","listen","wait",
      ];
      const sysPrompt =
        "You classify what a personal AI agent is doing so a mascot can pose accordingly. " +
        'Reply with ONLY a compact JSON object, no prose, no markdown: {"state":"<one of these>","verb":"<1-2 word action>"}. ' +
        "States: " + states.join(", ") + ". " +
        'Examples: {"state":"search","verb":"Digging the web"} {"state":"code","verb":"Poking the shell"} {"state":"idle","verb":"Ready"}.';
      try {
        const init: RequestInit = {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${env.ROUTER_KEY}`,
            "X-Tier": "cheap",
          },
          body: JSON.stringify({
            model: env.MODEL_CHEAP || "gemini3.7flash",
            messages: [
              { role: "system", content: sysPrompt },
              { role: "user", content: body.context },
            ],
            max_tokens: 600,
            stream: false,
          }),
        };
        // Service binding avoids workers.dev fetch challenges between Workers.
        const res = env.ROUTER
          ? await env.ROUTER.fetch(new Request(env.ROUTER_URL, init))
          : await fetch(env.ROUTER_URL, init);
        const text = await res.text();
        let parsed: { state?: string; verb?: string } | null = null;
        try {
          const data = JSON.parse(text) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          let raw = data.choices?.[0]?.message?.content ?? "";
          raw = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
          const m = raw.match(/\{[\s\S]*\}/);
          parsed = JSON.parse(m ? m[0] : raw) as { state?: string; verb?: string };
        } catch {
          return Response.json({
            state: "idle",
            error: `router ${res.status}: ${text.slice(0, 180)}`,
          });
        }
        const state = states.includes(parsed.state ?? "") ? parsed.state! : "idle";
        const verb = typeof parsed.verb === "string" && parsed.verb ? parsed.verb.slice(0, 40) : undefined;
        return Response.json({ state, verb });
      } catch (err) {
        return Response.json({ state: "idle", error: String(err) });
      }
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
