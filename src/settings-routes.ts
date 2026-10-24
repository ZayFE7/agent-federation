// The model settings surface. It is not part of the sessions family, so it lives
// in its own module and is called directly by src/index.ts.
//
// API keys enter over the authenticated request, are encrypted in the registry
// DO, and are never returned. GET answers a masked hint only.

import { authed } from "./auth.ts";
import { normalizeProviderId, parseProviderInput, normalizeBaseUrl } from "./model-input.ts";
import { keyHint } from "./model-secrets.ts";
import type { ModelProvider } from "./model-store";
import type { Env, RegistryStub } from "./types";

const PREFIX = "/api/settings";

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function fail(status: number, error: string): Response {
  return json({ ok: false, error }, status);
}

function registryStubFor(env: Env): RegistryStub {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
  return stub as unknown as RegistryStub;
}

function masked(provider: ModelProvider) {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    models: provider.models,
    hasKey: Boolean(provider.apiKey),
    keyHint: keyHint(provider.apiKey),
  };
}

async function readBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function testProvider(
  env: Env,
  id: string,
  model: string
): Promise<Response> {
  const settings = await registryStubFor(env).modelSettings();
  const provider = settings.providers.find((p) => p.id === id);
  if (!provider) return fail(404, "provider not found");
  const base = normalizeBaseUrl(provider.baseUrl);
  if (!base) return fail(400, "provider URL is not valid");
  const chosen = model || provider.models[0];
  if (!chosen) return fail(400, "provider has no model ids");
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: chosen,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 8,
        stream: false,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "error";
    return fail(
      502,
      name === "TimeoutError" || name === "AbortError"
        ? "The provider did not answer in 20 seconds."
        : "The provider could not be reached."
    );
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return fail(502, `The provider returned HTTP ${res.status}.`);
  }
  let reply = "";
  try {
    const parsed = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content === "string") reply = content.slice(0, 200);
  } catch {
    // A 2xx that is not JSON is still evidence the endpoint answered; the UI
    // reports the status and latency rather than inventing a reply.
  }
  return json({
    ok: true,
    status: res.status,
    latencyMs: Date.now() - started,
    reply,
  });
}

export async function handleSettings(
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
  const registry = registryStubFor(env);

  // GET /api/settings/models
  if (request.method === "GET" && parts.length === 1 && parts[0] === "models") {
    const settings = await registry.modelSettings();
    return json({
      ok: true,
      providers: settings.providers.map(masked),
      default: settings.default,
      deployment: {
        model: env.MODEL_PRIMARY ?? "",
        models: [env.MODEL_PRIMARY ?? "", env.MODEL_CHEAP ?? ""].filter(
          (value, index, all) => Boolean(value) && all.indexOf(value) === index
        ),
      },
    });
  }

  // POST /api/settings/providers
  if (request.method === "POST" && parts.length === 1 && parts[0] === "providers") {
    const parsed = parseProviderInput(await readBody(request));
    if (!parsed.ok) return fail(400, parsed.error);
    const saved = await registry.saveModelProvider(null, parsed.value);
    if (!saved) return fail(500, "Could not save the provider key.");
    return json({ ok: true, provider: masked(saved) });
  }

  // PUT/DELETE /api/settings/providers/:id
  if (parts.length === 2 && parts[0] === "providers") {
    const id = normalizeProviderId(parts[1]);
    if (!id) return fail(404, "not found");
    if (request.method === "PUT") {
      const parsed = parseProviderInput(await readBody(request));
      if (!parsed.ok) return fail(400, parsed.error);
      const saved = await registry.saveModelProvider(id, parsed.value);
      if (!saved) return fail(500, "Could not save the provider key.");
      return json({ ok: true, provider: masked(saved) });
    }
    if (request.method === "DELETE") {
      const removed = await registry.deleteModelProvider(id);
      if (!removed) return fail(404, "not found");
      return json({ ok: true });
    }
    return fail(405, "method not allowed");
  }

  // PUT /api/settings/default
  if (request.method === "PUT" && parts.length === 1 && parts[0] === "default") {
    const body = (await readBody(request)) as { provider?: unknown; model?: unknown } | null;
    if (typeof body?.provider !== "string" || typeof body?.model !== "string") {
      return fail(400, "provider and model required");
    }
    if (!(await registry.setModelDefault(body.provider, body.model))) {
      return fail(400, "unknown provider or model");
    }
    return json({ ok: true });
  }

  // POST /api/settings/test
  if (request.method === "POST" && parts.length === 1 && parts[0] === "test") {
    const body = (await readBody(request)) as { id?: unknown; model?: unknown } | null;
    if (typeof body?.id !== "string") return fail(400, "provider id required");
    const id = normalizeProviderId(body.id);
    if (!id) return fail(404, "not found");
    return testProvider(env, id, typeof body.model === "string" ? body.model : "");
  }

  return fail(404, "not found");
}
