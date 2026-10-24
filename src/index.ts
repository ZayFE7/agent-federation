import { FederationAgent } from "./agent";
import { RegistryAgent } from "./registry";
import { Researcher } from "./child";
import { fetchRouter } from "./router";
import { authed, safeEq, vaultAuthed } from "./auth";
import { MAIN_DO_NAME, isSessionId } from "./session-scope";
import { EXPECTED_TOOLS, capabilityList } from "./capabilities";
import { handleFetch } from "./routes";
import { handleSettings } from "./settings-routes";
import { handleMcp } from "./mcp-routes";
import { handleSkills } from "./skill-routes";
import { DEFAULT_MODEL_CHEAP } from "./types";
import type { AgentStub, Env } from "./types";

// Wrangler discovers Durable Object classes from the entry module's exports, so
// every class a binding names has to be exported here (plan Task 6 Step 1).
// Researcher is exported for the same reason and under its own class name: the
// SDK resolves a dynamic-agent facet through `ctx.exports[className]`, so a
// re-export under an alias would not be found at runtime.
export { FederationAgent, RegistryAgent, Researcher };

function mainAgentId(env: Env): DurableObjectId {
  return env.FEDERATION_AGENT.idFromName(MAIN_DO_NAME);
}

/**
 * `safeEq` and `authed` moved to src/auth.ts in Task 7 so one copy exists and an
 * offline test can reach them: src/routes.ts may import nothing but types plus
 * ./auth, which is exactly why src/index.ts keeps its own handlers here and
 * delegates only the /api/sessions* family below (R42).
 */

function agentStub(env: Env): AgentStub {
  const stub = env.FEDERATION_AGENT.get(mainAgentId(env));
  // Cast avoids depending on version-specific DurableObjectNamespace generics.
  return stub as unknown as AgentStub;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrades (path /) go straight to the agent DO; the Agents SDK
    // performs the hibernation handshake and dispatches frames to onMessage.
    // Gate the upgrade with the shared secret: handleChat can exec shell/Python
    // in the sandbox, so an unauthenticated socket is remote code execution by
    // URL. Browsers cannot set WS headers, so also accept ?token=<AGENT_API_KEY>.
    // Fail closed when no key is configured.
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const key = (env.AGENT_API_KEY ?? "").trim();
      const headerAuth = (request.headers.get("Authorization") ?? "")
        .replace(/^Bearer\s+/i, "")
        .trim();
      const queryAuth = (url.searchParams.get("token") ?? "").trim();
      if (!key || (!safeEq(headerAuth, key) && !safeEq(queryAuth, key))) {
        return new Response("unauthorized", { status: 401 });
      }
      const stub = env.FEDERATION_AGENT.get(mainAgentId(env));
      return stub.fetch(request);
    }

    // MCP server management and the OAuth callback. The callback is allowed
    // without the bearer because the provider redirect carries its own state.
    const mcpResponse = await handleMcp(request, env);
    if (mcpResponse) return mcpResponse;

    // The global skill library.
    const skillResponse = await handleSkills(request, env);
    if (skillResponse) return skillResponse;

    // Model provider settings and the global default live outside the session
    // family, so they have their own authenticated handler.
    const settingsResponse = await handleSettings(request, env);
    if (settingsResponse) return settingsResponse;

    // The /api/sessions* family lives in src/routes.ts, which is the only part of
    // this worker an offline Node test can import (R42). The prefix is the whole
    // handover: /api/tasks, /api/approve, /api/decide, the WebSocket
    // upgrade above and /internal/vault/* keep their addressing right here. The
    // delegation sits below the upgrade gate so an Upgrade: websocket request can
    // never be swallowed by the session family.
    if (url.pathname === "/api/sessions" || url.pathname.startsWith("/api/sessions/")) {
      return handleFetch(request, env, ctx);
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    // The capability list the console's Tools tab renders. It comes from the same
    // table the system prompt is assembled from, so the promise on screen cannot
    // lead or lag the promise made to the model (plan Task 29). Bearer-gated like
    // every other handover route: it names what this agent can reach.
    if (url.pathname === "/api/capabilities" && request.method === "GET") {
      if (!authed(request, env)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return Response.json({
        ok: true,
        tools: [...EXPECTED_TOOLS],
        capabilities: capabilityList(EXPECTED_TOOLS),
      });
    }

    if (url.pathname === "/api/tasks" && request.method === "GET") {
      if (!authed(request, env)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const list = await agentStub(env).jobList();
      return Response.json({ ok: true, tasks: list });
    }

    if (url.pathname === "/api/approve" && request.method === "POST") {
      if (!authed(request, env)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      let body: {
        sessionId?: string;
        toolCallId?: string;
        approved?: boolean;
        reason?: string;
      };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const sessionId = body.sessionId;
      if (typeof sessionId !== "string" || !isSessionId(sessionId)) {
        return Response.json({ error: "valid sessionId required" }, { status: 400 });
      }
      if (typeof body.toolCallId !== "string" || body.toolCallId.length === 0) {
        return Response.json({ error: "toolCallId required" }, { status: 400 });
      }
      const reason =
        typeof body.reason === "string" && body.reason ? body.reason.slice(0, 400) : undefined;
      // The parked call lives on the session DO that ran the turn, so address that
      // instance rather than main (R46 is about jobs; transcripts shard, R41).
      const stub = env.FEDERATION_AGENT.get(
        env.FEDERATION_AGENT.idFromName(sessionId)
      ) as unknown as AgentStub;
      const result = await stub.approveToolCall(
        sessionId,
        body.toolCallId,
        body.approved === true,
        reason
      );
      return Response.json(result);
    }

    if (url.pathname === "/api/decide" && request.method === "POST") {
      if (!authed(request, env)) {
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
        const res = await fetchRouter(
          env,
          "/v1/chat/completions",
          {
            model: env.MODEL_CHEAP ?? DEFAULT_MODEL_CHEAP,
            messages: [
              { role: "system", content: sysPrompt },
              { role: "user", content: body.context },
            ],
            max_tokens: 600,
          },
          false
        );
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
    // Gated by STATE_KEY via vaultAuthed (Task 35), evaluated lazily inside each
    // branch below so a non-vault request never touches that secret.
    if (url.pathname === "/internal/vault/push" && request.method === "POST") {
      if (!vaultAuthed(request, env)) {
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
      if (!vaultAuthed(request, env)) {
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
      if (!vaultAuthed(request, env)) {
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
      if (!vaultAuthed(request, env)) {
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
      if (!vaultAuthed(request, env)) {
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
