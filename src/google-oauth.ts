// Google's OAuth 2.0 web-server flow for Gmail. Dependency-free and pure:
// callers pass fetch, and nothing here logs tokens, codes, or client secrets.
// No PKCE: Google's web-server flow uses the client secret per the connector
// design.

import {
  GMAIL_SCOPE,
  GOOGLE_AUTH_URL,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  type GoogleTokens,
  type GoogleUserInfo,
} from "./google-types.ts";

/** Matches the Worker runtime's fetch and makes fake fetch injection explicit. */
export type GoogleFetch = typeof fetch;

export interface GoogleAuthUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  loginHint?: string | null;
}

export interface GoogleCodeExchangeInput {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}

export interface GoogleRefreshInput {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

const MAX_ERROR_CHARS = 300;
const DEFAULT_EXPIRES_IN = 3600;

function requireText(
  value: string | null | undefined,
  label: string
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Redact likely credential shapes before any server detail is surfaced. */
function scrubTokenShapes(text: string): string {
  return text
    .replace(
      /\b(access_token|refresh_token|id_token|client_secret|authorization_code|code)\s*[=:]\s*["']?[^"'\s&,}]+/gi,
      "$1=[redacted]"
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
}

function clip(text: string, max = MAX_ERROR_CHARS): string {
  return text.length > max ? text.slice(0, max) : text;
}

function redactKnownSecrets(message: string, secrets: string[]): string {
  let result = message;
  for (const secret of secrets) {
    if (!secret) continue;
    result = result.split(secret).join("[redacted]");
  }
  return result;
}

function errorFields(body: unknown): { code: string; detail: string } {
  let code = "";
  let detail = "";
  let parsed: unknown = null;
  if (typeof body === "string") {
    detail = body;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Plain-text error bodies are common from proxies.
    }
  } else if (body && typeof body === "object" && !Array.isArray(body)) {
    parsed = body;
  }

  const record = asRecord(parsed);
  if (record) {
    if (typeof record.error === "string") {
      code = record.error;
    } else {
      const nested = asRecord(record.error);
      if (nested && typeof nested.status === "string") code = nested.status;
    }
    if (typeof record.error_description === "string") {
      detail = record.error_description;
    } else if (typeof record.message === "string") {
      detail = record.message;
    } else if (typeof body === "string") {
      // A JSON object without a known field: never echo its raw payload.
      detail = "";
    }
  }

  const cleanCode = scrubTokenShapes(code.replace(/\s+/g, " ").trim()).toLowerCase();
  const cleanDetail = clip(scrubTokenShapes(detail.replace(/\s+/g, " ").trim()));

  if (!cleanCode) {
    const known =
      /\b(invalid_grant|invalid_client|invalid_request|invalid_token|redirect_uri_mismatch|access_denied|insufficient_scope|unauthorized_client|unsupported_grant_type)\b/i.exec(
        cleanDetail
      );
    if (known) return { code: known[1].toLowerCase(), detail: cleanDetail };
  }
  return { code: cleanCode, detail: cleanDetail };
}

/**
 * Readable, credential-free message for a Google error response. Accepts the
 * raw body text or an already-parsed JSON object. The final string is capped
 * at 300 characters even when the server sent more.
 */
export function classifyGoogleError(status: number, body: unknown): string {
  const { code, detail } = errorFields(body);
  let message: string;

  switch (code) {
    case "invalid_grant":
      message =
        "Google authorization expired or was revoked (invalid_grant). Reconnect the Google account.";
      break;
    case "invalid_client":
      message =
        "Google rejected the OAuth client credentials (invalid_client). Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.";
      break;
    case "redirect_uri_mismatch":
      message =
        "Google rejected the redirect URI (redirect_uri_mismatch). Use the exact callback URL configured in Google Cloud.";
      break;
    case "access_denied":
      message = "Google access was denied (access_denied).";
      break;
    case "insufficient_scope":
      message =
        "Google did not grant the required Gmail permissions (insufficient_scope). Reconnect and approve access.";
      break;
    case "invalid_token":
      message =
        "Google rejected the access token (invalid_token). Reconnect the Google account.";
      break;
    case "invalid_request":
      message = "Google rejected the OAuth request (invalid_request).";
      break;
    case "unauthorized_client":
      message =
        "Google does not allow this client to use the requested grant (unauthorized_client).";
      break;
    case "unsupported_grant_type":
      message =
        "Google does not support this authorization grant (unsupported_grant_type).";
      break;
    default:
      if (status === 429) {
        message = "Google rate-limited the request (HTTP 429). Try again shortly.";
      } else if (status >= 500) {
        message = `Google is temporarily unavailable (HTTP ${status}). Try again shortly.`;
      } else if (status === 401) {
        message =
          "Google rejected the credentials (HTTP 401). Reconnect the Google account.";
      } else if (status === 403) {
        message =
          "Google denied access (HTTP 403). Check the OAuth scopes and account access.";
      } else if (code) {
        message = `Google OAuth request failed (HTTP ${status}, ${code}).`;
      } else {
        message = `Google OAuth request failed (HTTP ${status}).`;
      }
  }

  const suffix =
    detail && detail.toLowerCase() !== code ? ` ${detail}` : "";
  return clip(`${message}${suffix}`);
}

/** Auth URL with the full Gmail scope, offline access, and account choice. */
export function buildGoogleAuthUrl(input: GoogleAuthUrlInput): string {
  const clientId = requireText(input.clientId, "Google client id");
  const redirectUri = requireText(input.redirectUri, "Google redirect URI");
  const state = requireText(input.state, "OAuth state");

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent select_account");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  if (typeof input.loginHint === "string" && input.loginHint.trim()) {
    url.searchParams.set("login_hint", input.loginHint.trim());
  }
  return url.toString();
}

function parseScopes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string => typeof item === "string" && item.trim() !== ""
    );
  }
  if (typeof value === "string") {
    return value.split(/\s+/).filter(Boolean);
  }
  return [];
}

function parseExpiresIn(value: unknown): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return DEFAULT_EXPIRES_IN;
  return Math.floor(numeric);
}

function tokensFrom(
  raw: unknown,
  status: number,
  secrets: string[]
): GoogleTokens {
  const record = asRecord(raw);
  if (!record) {
    throw new Error("Google returned an empty token response. Try again.");
  }

  if (record.error !== undefined || record.error_description !== undefined) {
    const code =
      typeof record.error === "string" ? record.error : "token_error";
    const description =
      typeof record.error_description === "string"
        ? record.error_description
        : "";
    const safeBody = JSON.stringify({
      error: code,
      error_description: description,
    });
    throw new Error(
      redactKnownSecrets(classifyGoogleError(status, safeBody), secrets)
    );
  }

  const accessToken =
    typeof record.access_token === "string" ? record.access_token : "";
  if (accessToken.trim() === "") {
    throw new Error(
      "Google did not return an access token. Reconnect the Google account and try again."
    );
  }

  const refreshToken =
    typeof record.refresh_token === "string" &&
    record.refresh_token.trim() !== ""
      ? record.refresh_token
      : "";
  const tokens: GoogleTokens = {
    accessToken,
    expiresIn: parseExpiresIn(record.expires_in),
    scopes: parseScopes(record.scope),
  };
  if (refreshToken) tokens.refreshToken = refreshToken;
  return tokens;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function requestTokens(
  form: URLSearchParams,
  fetchImpl: GoogleFetch,
  secrets: string[]
): Promise<GoogleTokens> {
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form.toString(),
    });
  } catch {
    throw new Error(
      "Could not reach Google's token service. Check the network and try again."
    );
  }

  if (!response.ok) {
    const body = await safeText(response);
    throw new Error(
      redactKnownSecrets(classifyGoogleError(response.status, body), secrets)
    );
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error("Google returned an unreadable token response. Try again.");
  }
  return tokensFrom(raw, response.status, secrets);
}

export async function exchangeGoogleCode(
  input: GoogleCodeExchangeInput,
  fetchImpl: GoogleFetch = fetch
): Promise<GoogleTokens> {
  const clientId = requireText(input.clientId, "Google client id");
  const clientSecret = requireText(input.clientSecret, "Google client secret");
  const code = requireText(input.code, "Google authorization code");
  const redirectUri = requireText(input.redirectUri, "Google redirect URI");

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });
  return requestTokens(form, fetchImpl, [code, clientSecret]);
}

export async function refreshGoogleToken(
  input: GoogleRefreshInput,
  fetchImpl: GoogleFetch = fetch
): Promise<GoogleTokens> {
  const clientId = requireText(input.clientId, "Google client id");
  const clientSecret = requireText(input.clientSecret, "Google client secret");
  const refreshToken = requireText(input.refreshToken, "Google refresh token");

  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  return requestTokens(form, fetchImpl, [refreshToken, clientSecret]);
}

export async function fetchGoogleUserInfo(
  accessToken: string,
  fetchImpl: GoogleFetch = fetch
): Promise<GoogleUserInfo> {
  const token = requireText(accessToken, "Google access token");

  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_USERINFO_URL, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
    });
  } catch {
    throw new Error(
      "Could not reach Google to verify the account. Check the network and try again."
    );
  }

  if (!response.ok) {
    const body = await safeText(response);
    throw new Error(
      redactKnownSecrets(classifyGoogleError(response.status, body), [token])
    );
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error("Google returned an unreadable user profile. Try again.");
  }
  const record = asRecord(raw);
  if (!record) {
    throw new Error("Google returned an empty user profile. Try again.");
  }

  const sub = typeof record.sub === "string" ? record.sub.trim() : "";
  const email = typeof record.email === "string" ? record.email.trim() : "";
  if (!sub) {
    throw new Error(
      "Google did not return an account id (sub). Reconnect the Google account."
    );
  }
  if (!email) {
    throw new Error(
      "Google did not return an email address. Reconnect the Google account."
    );
  }

  const info: GoogleUserInfo = { sub, email };
  if (typeof record.name === "string" && record.name.trim() !== "") {
    info.name = record.name;
  }
  if (typeof record.picture === "string" && record.picture.trim() !== "") {
    info.picture = record.picture;
  }
  return info;
}

/** False on any failure so local disconnect can proceed after a bad network. */
export async function revokeGoogleToken(
  token: string,
  fetchImpl: GoogleFetch = fetch
): Promise<boolean> {
  if (typeof token !== "string" || token.trim() === "") return false;
  try {
    const response = await fetchImpl(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({ token }).toString(),
    });
    return response.ok;
  } catch {
    return false;
  }
}
