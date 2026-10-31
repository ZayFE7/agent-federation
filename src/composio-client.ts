// Thin Composio v3.1 client. Composio owns the Google OAuth app, refresh
// tokens, and tool execution; BLIP stores only the project key and the user id.

import type { Env } from "./types";
import type { GoogleAccountStatus, GoogleAccountView } from "./google-types";

export const COMPOSIO_API_BASE = "https://backend.composio.dev/api/v3.1";
export const COMPOSIO_USER_ID = "blip-zay";

export class ComposioError extends Error {}

export function composioConfigured(env: Env): boolean {
  return Boolean(env.COMPOSIO_API_KEY?.trim());
}

function apiKey(env: Env): string {
  const key = env.COMPOSIO_API_KEY?.trim();
  if (!key) throw new ComposioError("Composio is not configured.");
  return key;
}

export interface ComposioConnectedAccount {
  id: string;
  alias?: string;
  status?: string;
  status_reason?: string | null;
  created_at?: string;
  updated_at?: string;
  data?: {
    displayName?: string;
    email?: string;
    name?: string;
    picture?: string;
    scope?: string | string[];
    status?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

async function request(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<Record<string, unknown>> {
  const res = await fetch(`${COMPOSIO_API_BASE}${path}`, {
    ...init,
    headers: {
      "x-api-key": apiKey(env),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const message =
      (parsed?.error as { message?: string } | string | undefined) ??
      (typeof parsed?.message === "string" ? parsed.message : raw);
    throw new ComposioError(
      `Composio ${res.status}: ${
        typeof message === "string" ? message.slice(0, 400) : "request failed"
      }`
    );
  }
  if (!parsed) throw new ComposioError("Composio returned an invalid response.");
  return parsed;
}

export async function listConnectedAccounts(
  env: Env,
  toolkit: string
): Promise<ComposioConnectedAccount[]> {
  const query = new URLSearchParams({
    user_ids: COMPOSIO_USER_ID,
    toolkit_slugs: toolkit,
  });
  const data = await request(env, `/connected_accounts?${query.toString()}`, {
    method: "GET",
  });
  return Array.isArray(data.items) ? (data.items as ComposioConnectedAccount[]) : [];
}

export async function createConnectLink(
  env: Env,
  toolkit: string,
  alias?: string
): Promise<{ redirectUrl: string; connectedAccountId: string | null; sessionId: string }> {
  const session = await request(env, "/tool_router/session", {
    method: "POST",
    body: JSON.stringify({
      user_id: COMPOSIO_USER_ID,
      toolkits: { enable: [toolkit] },
      multi_account: {
        enable: true,
        max_accounts_per_toolkit: 10,
        require_explicit_selection: true,
      },
    }),
  });
  const sessionId = typeof session.session_id === "string" ? session.session_id : "";
  if (!sessionId) throw new ComposioError("Composio did not return a session.");
  const link = await request(env, `/tool_router/session/${encodeURIComponent(sessionId)}/link`, {
    method: "POST",
    body: JSON.stringify({
      toolkit,
      alias: alias?.trim() || `${toolkit}-${Date.now().toString(36)}`,
    }),
  });
  const redirectUrl = typeof link.redirect_url === "string" ? link.redirect_url : "";
  if (!redirectUrl) throw new ComposioError("Composio did not return a connect link.");
  return {
    redirectUrl,
    connectedAccountId:
      typeof link.connected_account_id === "string" ? link.connected_account_id : null,
    sessionId,
  };
}

export async function deleteConnectedAccount(env: Env, id: string): Promise<void> {
  await request(env, `/connected_accounts/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Execute one Composio tool as the connected account. */
export async function executeTool(
  env: Env,
  connectedAccountId: string,
  toolSlug: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const result = await request(env, `/tools/execute/${encodeURIComponent(toolSlug)}`, {
    method: "POST",
    body: JSON.stringify({
      user_id: COMPOSIO_USER_ID,
      connected_account_id: connectedAccountId,
      arguments: args,
    }),
  });
  if (result.successful === false) {
    const error = result.error;
    const message =
      typeof error === "string"
        ? error
        : error && typeof error === "object" && "message" in error
          ? String((error as { message?: unknown }).message ?? "tool failed")
          : "tool failed";
    throw new ComposioError(`Gmail ${toolSlug}: ${message.slice(0, 400)}`);
  }
  const data = result.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : { value: data };
}

function accountStatus(raw: string | undefined): GoogleAccountStatus {
  switch (String(raw || "").toUpperCase()) {
    case "ACTIVE":
      return "active";
    case "INITIATED":
    case "INITIALIZING":
    case "EXPIRED":
      return "reauth_required";
    case "FAILED":
    case "REVOKED":
      return "revoked";
    default:
      return "revoked";
  }
}

function scopesOf(data: ComposioConnectedAccount["data"]): string[] {
  const raw = data?.scope;
  if (Array.isArray(raw)) {
    return raw.filter((scope): scope is string => typeof scope === "string" && scope !== "");
  }
  if (typeof raw === "string") return raw.split(/\s+/).filter(Boolean);
  return [];
}

function emailOf(row: ComposioConnectedAccount): string {
  const data = row.data ?? {};
  const candidates = [data.email, data.displayName, data.username];
  for (const value of candidates) {
    if (typeof value === "string" && value.includes("@")) return value;
  }
  return row.alias || row.id;
}

/** Connected accounts for one toolkit in the console's own view shape. */
export async function listToolkitAccounts(
  env: Env,
  toolkit: string
): Promise<GoogleAccountView[]> {
  const rows = await listConnectedAccounts(env, toolkit);
  const accounts: GoogleAccountView[] = rows.map((row) => {
    const data = row.data ?? {};
    const status = accountStatus(row.status ?? data.status);
    const created = Date.parse(row.created_at || row.updated_at || "");
    const updated = Date.parse(row.updated_at || row.created_at || "");
    return {
      id: row.id,
      email: emailOf(row),
      name: typeof data.name === "string" ? data.name : null,
      picture: typeof data.picture === "string" ? data.picture : null,
      is_default: false,
      status,
      scopes: scopesOf(data),
      last_error:
        typeof row.status_reason === "string" && row.status_reason
          ? row.status_reason
          : null,
      last_refresh_at: Number.isFinite(updated) ? updated : null,
      created_at: Number.isFinite(created) ? created : Date.now(),
    };
  });
  const firstActive = accounts.find((account) => account.status === "active");
  if (firstActive) firstActive.is_default = true;
  // A link that was never finished has only an alias, not an email. Keep it out
  // of the account list until Google actually authorizes a mailbox.
  return accounts.filter(
    (account) => account.email.includes("@") || account.status === "active"
  );
}

export async function listGmailAccounts(env: Env): Promise<GoogleAccountView[]> {
  return listToolkitAccounts(env, "gmail");
}
