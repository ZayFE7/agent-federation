// The router as an AI SDK language model. One provider factory, one fetch
// wrapper, and the two model ids this worker uses. The AI SDK builds every
// request as `baseURL + "/chat/completions"`, so baseURL must be absolute and
// already end in `/v1`: routerUrl(env, "/v1") is the only correct value.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { routerUrl } from "./router.ts";
import type { Env } from "./types.ts";
import { DEFAULT_MODEL_CHEAP, DEFAULT_MODEL_PRIMARY } from "./types.ts";

/**
 * `fetch` shaped for the provider, routed through the ROUTER service binding
 * when the worker has one. The SDK hands us an absolute URL and its own headers
 * (including a bearer when `apiKey` is set), so the init headers are forwarded
 * as-is; the router key is stamped only when the SDK left authorization out.
 * Never rebuild the header list from scratch: dropping `init.headers` drops the
 * SDK's bearer and every call comes back 401 with no clue why.
 */
export function routerFetch(env: Env): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("authorization")) {
      headers.set("authorization", `Bearer ${env.ROUTER_KEY}`);
    }
    const request = new Request(input, { ...init, headers });
    // workerd reads `signal` from fetch's init, not from the Request, so it is
    // forwarded separately on both paths (same rule as src/router.ts).
    const next = init?.signal ? { signal: init.signal } : undefined;
    return env.ROUTER ? env.ROUTER.fetch(request, next) : fetch(request, next);
  };
}

/** One chat model behind the router. `modelId` is what the router resolves a lane from. */
export function createRouterModel(env: Env, modelId: string): LanguageModel {
  const provider = createOpenAICompatible({
    name: "zay-router",
    baseURL: routerUrl(env, "/v1"),
    apiKey: env.ROUTER_KEY,
    fetch: routerFetch(env),
    includeUsage: true,
  });
  return provider.chatModel(modelId);
}

/**
 * Non-tool uses ONLY: session titles, self-critique, `/api/decide`. This is the
 * cost/latency lane, not a lane that cannot tool: `ocf/deepseek-v4.1-flash-free`
 * completed a full tool round trip through the funnel when re-pinned (2026-10-21),
 * but the harness turns still use `createPrimaryModel`. The `ocf/` prefix only
 * resolves when `ROUTER_URL` is the funnel, not the cloud `zay-router` Worker.
 */
export function createCheapModel(env: Env): LanguageModel {
  return createRouterModel(env, env.MODEL_CHEAP ?? DEFAULT_MODEL_CHEAP);
}

/**
 * The harness lane. `modelId` is the console's per-session pick; an empty or
 * absent override falls back to the pinned var, so clearing a choice can never
 * leave a turn with no model.
 */
export function createPrimaryModel(env: Env, modelId?: string | null): LanguageModel {
  return createRouterModel(env, modelId || (env.MODEL_PRIMARY ?? DEFAULT_MODEL_PRIMARY));
}
