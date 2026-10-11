import { FederationAgent } from "./agent";
import type { AgentReply, ChatRequest, ChatTier, Env } from "./types";

export { FederationAgent };

/** Minimal RPC surface of FederationAgent used over the DO stub. */
interface AgentStub {
  chat(content: string, tier?: ChatTier): Promise<AgentReply>;
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

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
