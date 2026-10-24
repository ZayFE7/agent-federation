// MCP server management and the OAuth callback hop. The connections live on the
// main DO; every route here addresses that one instance.

import { authed } from "./auth.ts";
import type { AgentStub, Env } from "./types";

const PREFIX = "/api/mcp";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function fail(status: number, error: string): Response {
  return json({ ok: false, error }, status);
}

function mainStub(env: Env): AgentStub {
  const stub = env.FEDERATION_AGENT.get(env.FEDERATION_AGENT.idFromName("main"));
  return stub as unknown as AgentStub;
}

function privateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h === "::1" ||
    h.endsWith(".local") ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h)
  );
}

function mcpUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (privateHost(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function headersFrom(raw: unknown): Record<string, string> | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  const entries = Object.entries(raw as Record<string, unknown>).slice(0, 20);
  for (const [key, value] of entries) {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(key) || typeof value !== "string") return null;
    if (value.length > 2000) return null;
    out[key] = value;
  }
  return out;
}

export async function handleMcp(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;

  // OAuth providers redirect the browser here. The SDK validates state and PKCE;
  // this route only forwards the request to the manager that owns the connection.
  if (url.pathname === `${PREFIX}/callback` && request.method === "GET") {
    return mainStub(env).fetch(request);
  }

  if (!authed(request, env)) return fail(401, "unauthorized");
  const parts = url.pathname.slice(PREFIX.length).split("/").filter(Boolean);

  if (parts.length === 1 && parts[0] === "servers" && request.method === "GET") {
    return json({ ok: true, ...(await mainStub(env).mcpServers()) });
  }

  if (parts.length === 1 && parts[0] === "servers" && request.method === "POST") {
    let body: { name?: unknown; url?: unknown; headers?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return fail(400, "invalid JSON body");
    }
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
    if (!name) return fail(400, "name required");
    const target = mcpUrl(body.url);
    if (!target) return fail(400, "url must be a public HTTPS URL");
    const headers = headersFrom(body.headers);
    if (!headers) return fail(400, "headers must be a flat object of short strings");
    const result = await mainStub(env).mcpAdd(name, target, headers, url.origin);
    if (!result.ok) return fail(502, result.error ?? "could not add the MCP server");
    return json(result);
  }

  if (parts.length === 2 && parts[0] === "servers") {
    const id = /^[A-Za-z0-9_-]{1,80}$/.test(parts[1]) ? parts[1] : "";
    if (!id) return fail(404, "not found");
    if (request.method === "DELETE") {
      if (!(await mainStub(env).mcpRemove(id))) return fail(404, "not found");
      return json({ ok: true });
    }
  }

  // A reconnect path has three segments: /servers/:id/reconnect.
  if (
    parts.length === 3 &&
    parts[0] === "servers" &&
    parts[2] === "reconnect" &&
    request.method === "POST"
  ) {
    const id = /^[A-Za-z0-9_-]{1,80}$/.test(parts[1]) ? parts[1] : "";
    if (!id) return fail(404, "not found");
    const result = await mainStub(env).mcpReconnect(id);
    if (!result.ok) return fail(502, result.error ?? "reconnect failed");
    return json(result);
  }

  if (parts.length === 1 && parts[0] === "call" && request.method === "POST") {
    let body: { server?: unknown; tool?: unknown; arguments?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return fail(400, "invalid JSON body");
    }
    if (typeof body.server !== "string" || typeof body.tool !== "string") {
      return fail(400, "server and tool required");
    }
    const input =
      body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments)
        ? (body.arguments as Record<string, unknown>)
        : {};
    return json({
      ok: true,
      output: await mainStub(env).mcpCall(body.server, body.tool, input),
    });
  }

  return fail(404, "not found");
}
