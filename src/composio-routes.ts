// Composio-managed toolkit connections beyond Gmail. The user connects each
// toolkit with a Composio link; the client resolves the active account.

import { authed } from "./auth.ts";
import type { Env } from "./types";
import {
  composioConfigured,
  createConnectLink,
  deleteConnectedAccount,
  listToolkitAccounts,
} from "./composio-client.ts";

const PREFIX = "/api/connections/composio";

const TOOLKITS = [
  { slug: "googlecalendar", name: "Google Calendar" },
  { slug: "googletasks", name: "Google Tasks" },
] as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
function fail(status: number, error: string): Response {
  return json({ ok: false, error }, status);
}
function toolkitName(slug: string): string | null {
  return TOOLKITS.find((toolkit) => toolkit.slug === slug)?.name ?? null;
}
function isAccountId(value: string): boolean {
  return /^ca_[A-Za-z0-9]{8,40}$/.test(value);
}

export async function handleComposioConnections(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
  if (!authed(request, env)) return fail(401, "unauthorized");
  const parts = url.pathname
    .slice(PREFIX.length)
    .split("/")
    .filter(Boolean);

  if (parts.length === 0 && request.method === "GET") {
    if (!composioConfigured(env)) {
      return json({ ok: true, configured: false, connectors: [] });
    }
    try {
      const connectors = await Promise.all(
        TOOLKITS.map(async (toolkit) => {
          const accounts = await listToolkitAccounts(env, toolkit.slug);
          return {
            slug: toolkit.slug,
            name: toolkit.name,
            accounts,
            active: accounts.filter((account) => account.status === "active").length,
          };
        })
      );
      return json({ ok: true, configured: true, connectors });
    } catch (err) {
      return fail(502, String(err).slice(0, 400));
    }
  }

  if (parts.length === 2 && parts[1] === "start" && request.method === "POST") {
    const name = toolkitName(parts[0]);
    if (!name) return fail(404, "unknown connector");
    try {
      const link = await createConnectLink(env, parts[0], `${parts[0]}-${Date.now().toString(36)}`);
      return json({
        ok: true,
        provider: "composio",
        authUrl: link.redirectUrl,
        connectedAccountId: link.connectedAccountId,
      });
    } catch (err) {
      return fail(502, String(err).slice(0, 400));
    }
  }

  if (parts.length === 3 && request.method === "DELETE") {
    if (!toolkitName(parts[0])) return fail(404, "unknown connector");
    if (!isAccountId(parts[2])) return fail(400, "invalid account id");
    try {
      await deleteConnectedAccount(env, parts[2]);
      return json({ ok: true });
    } catch (err) {
      return fail(502, String(err).slice(0, 400));
    }
  }

  return fail(404, "not found");
}
