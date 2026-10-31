// Google account connection routes. OAuth start/status/accounts are owner-only;
// the callback is public because Google redirects the browser to it, but it is
// protected by the single-use state row created by the authenticated start.

import { authed } from "./auth.ts";
import type { Env, RegistryStub } from "./types";
import type { GoogleAccountView } from "./google-types";
import {
  composioConfigured,
  createConnectLink,
  deleteConnectedAccount,
  listGmailAccounts,
} from "./composio-client.ts";

const PREFIX = "/api/connections/google";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
function fail(status: number, error: string): Response {
  return json({ ok: false, error }, status);
}
function registryStub(env: Env): RegistryStub {
  return env.REGISTRY.get(env.REGISTRY.idFromName("registry")) as unknown as RegistryStub;
}
function originOf(request: Request): string {
  return new URL(request.url).origin;
}
function isAccountId(value: string): boolean {
  return /^(ga_[a-z0-9]{8,32}|ca_[A-Za-z0-9]{8,40})$/.test(value);
}
async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const raw = await request.text();
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function handleGoogleConnections(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;

  if (url.pathname === `${PREFIX}/callback`) {
    if (request.method !== "GET") return fail(405, "method not allowed");
    const error = url.searchParams.get("error");
    if (error) {
      return Response.redirect(
        `${url.origin}/?google=error&reason=${encodeURIComponent(error.slice(0, 80))}`,
        302
      );
    }
    const code = (url.searchParams.get("code") ?? "").trim();
    const state = (url.searchParams.get("state") ?? "").trim();
    if (!code || !state) {
      return Response.redirect(`${url.origin}/?google=error&reason=missing_code`, 302);
    }
    try {
      const result = await registryStub(env).googleComplete(code, state);
      if (!result.ok) {
        return Response.redirect(
          `${url.origin}/?google=error&reason=${encodeURIComponent((result.error ?? "connect").slice(0, 80))}`,
          302
        );
      }
      return Response.redirect(`${url.origin}/?google=connected`, 302);
    } catch {
      return Response.redirect(`${url.origin}/?google=error&reason=callback_failed`, 302);
    }
  }

  if (!authed(request, env)) return fail(401, "unauthorized");

  if (url.pathname === `${PREFIX}/start` && request.method === "GET") {
    if (composioConfigured(env)) {
      try {
        const link = await createConnectLink(env, "gmail");
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
    const loginHint = (url.searchParams.get("login_hint") ?? "").trim() || undefined;
    const result = await registryStub(env).googleBegin(originOf(request), loginHint);
    if (!result.ok) return fail(409, result.error ?? "google_not_configured");
    return json(result);
  }
  if (url.pathname === `${PREFIX}/status` && request.method === "GET") {
    if (composioConfigured(env)) {
      try {
        const accounts = await listGmailAccounts(env);
        const active = accounts.filter((account) => account.status === "active");
        return json({
          ok: true,
          configured: true,
          provider: "composio",
          redirectUri: null,
          accounts: active.length,
          defaultEmail: active.find((account) => account.is_default)?.email ?? null,
        });
      } catch (err) {
        return fail(502, String(err).slice(0, 400));
      }
    }
    return json({
      ok: true,
      provider: "google",
      ...(await registryStub(env).googleStatus(originOf(request))),
    });
  }
  if (url.pathname === `${PREFIX}/accounts` && request.method === "GET") {
    if (composioConfigured(env)) {
      try {
        return json({ ok: true, accounts: await listGmailAccounts(env) });
      } catch (err) {
        return fail(502, String(err).slice(0, 400));
      }
    }
    const accounts = await registryStub(env).googleAccounts();
    return json({ ok: true, accounts });
  }
  if (url.pathname === `${PREFIX}/default` && request.method === "PUT") {
    if (composioConfigured(env)) {
      return fail(409, "Composio chooses the default account from the active connections.");
    }
    const body = await readJson(request);
    const id = typeof body?.id === "string" ? body.id.trim() : "";
    if (!isAccountId(id)) return fail(400, "invalid account id");
    const ok = await registryStub(env).googleSetDefault(id);
    return ok ? json({ ok: true }) : fail(404, "not found");
  }
  if (url.pathname.startsWith(`${PREFIX}/accounts/`) && request.method === "DELETE") {
    const id = url.pathname.slice(`${PREFIX}/accounts/`.length);
    if (!isAccountId(id)) return fail(400, "invalid account id");
    if (composioConfigured(env) && id.startsWith("ca_")) {
      try {
        await deleteConnectedAccount(env, id);
        return json({ ok: true });
      } catch (err) {
        return fail(502, String(err).slice(0, 400));
      }
    }
    const ok = await registryStub(env).googleDelete(id);
    return ok ? json({ ok: true }) : fail(404, "not found");
  }
  return fail(404, "not found");
}

export type { GoogleAccountView };
