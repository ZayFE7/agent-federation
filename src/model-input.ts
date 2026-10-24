// Validation for model providers. Dependency-free so settings routes and the
// registry can load it under plain Node, and tests can run without a Worker.

import { parseModelId } from "./registry-input.ts";

export const MAX_PROVIDER_ID_CHARS = 32;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

export interface ProviderInput {
  name: string;
  baseUrl: string;
  models: string[];
  apiKey?: string;
  clearKey?: boolean;
}

export function normalizeProviderId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (!value || value.length > MAX_PROVIDER_ID_CHARS) return null;
  return PROVIDER_ID_RE.test(value) ? value : null;
}

function privateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".local") || h === "::1") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  const m = /^172\.(\d+)\./.exec(h);
  return Boolean(m && Number(m[1]) >= 16 && Number(m[1]) <= 31);
}

/**
 * A provider URL is what the Worker will call, so it must be HTTPS, carry no
 * embedded credentials, and cannot point at a local or private address. The
 * returned value always ends in `/v1`, because the AI SDK appends
 * `/chat/completions`.
 */
export function normalizeBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (privateHost(url.hostname)) return null;
  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(/\/(?:v1\/)?chat\/completions$/i, "");
  if (!/\/v1$/i.test(path)) path += "/v1";
  return url.origin + path;
}

export function normalizeModels(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return null;
    const parsed = parseModelId({ model: item });
    if (!parsed.ok || parsed.model === null) return null;
    if (seen.has(parsed.model)) continue;
    seen.add(parsed.model);
    models.push(parsed.model);
  }
  if (models.length === 0 || models.length > 40) return null;
  return models;
}

export function parseProviderInput(
  raw: unknown
): { ok: true; value: ProviderInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "provider body required" };
  }
  const body = raw as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
  if (!name) return { ok: false, error: "name required" };
  const baseUrl = normalizeBaseUrl(body.baseUrl);
  if (!baseUrl) return { ok: false, error: "baseUrl must be a public HTTPS URL" };
  const models = normalizeModels(body.models);
  if (!models) return { ok: false, error: "models must be one to forty valid model ids" };
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : undefined;
  if (apiKey !== undefined && apiKey.length > 400) {
    return { ok: false, error: "apiKey is too long" };
  }
  return {
    ok: true,
    value: {
      name,
      baseUrl,
      models,
      ...(apiKey === undefined || apiKey === "" ? {} : { apiKey }),
      ...(body.clearKey === true ? { clearKey: true } : {}),
    },
  };
}
