// Router access in one place: normalize whatever ROUTER_URL is configured to into
// a single chat endpoint, build the request, and send it through the ROUTER
// service binding when the binding exists (it avoids workers.dev fetch challenges
// between Workers), falling back to the network fetch when it does not.
//
// Dependency-free with type-only imports (only ./types), so tests/router.test.mjs
// can load this file with plain Node and no build step. No tier header is set
// here by construction; the router picks the lane from the model id.

import type { Env } from "./types";

/**
 * Endpoint suffixes ROUTER_URL may already carry, longest first. It is configured
 * as a complete endpoint today, not an origin, so these must be stripped before
 * the path is appended or every call would 404 on a doubled suffix.
 */
const ENDPOINT_SUFFIXES = ["/v1/chat/completions", "/chat/completions"];

/** Drop trailing slashes (none, one, or more) from the end of a URL. */
function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return url.slice(0, end);
}

/**
 * Append `path` to `base`, collapsing any tail of `base` that already repeats the
 * head of `path`. A base ending in "/v1" plus "/v1/chat/completions" is one
 * "/v1/chat/completions"; a base carrying a host path prefix keeps that prefix.
 * Only "/" boundaries are considered, so "/base" never matches "/v1/...".
 */
function joinPath(base: string, path: string): string {
  const loweredBase = base.toLowerCase();
  const loweredPath = path.toLowerCase();
  for (let i = base.length - 1; i >= 0; i--) {
    if (base[i] !== "/") continue;
    const tail = loweredBase.slice(i);
    if (tail.length <= loweredPath.length && loweredPath.startsWith(tail)) {
      return base.slice(0, i) + path;
    }
  }
  return base + path;
}

/**
 * The absolute URL for one router call. Idempotent: feeding the result back in as
 * `env.ROUTER_URL` with the same path returns it unchanged.
 */
export function routerUrl(env: Env, path: string): string {
  let base = trimTrailingSlashes((env.ROUTER_URL || "").trim());
  const lowered = base.toLowerCase();
  for (const suffix of ENDPOINT_SUFFIXES) {
    if (lowered.endsWith(suffix)) {
      base = trimTrailingSlashes(base.slice(0, base.length - suffix.length));
      break;
    }
  }
  if (!base) return path;
  return joinPath(base, path);
}

/**
 * A POST to `routerUrl(env, path)` carrying the Bearer router key and a JSON body
 * with the `stream` flag stamped in. Deliberately takes no AbortSignal: workers read
 * `signal` from fetch's RequestInit, not from the Request constructor, so a signal
 * attached here would be dropped and every call-site timeout would go inert.
 * `fetchRouter` is the only place a caller can hand one over.
 */
export function routerRequest(
  env: Env,
  path: string,
  body: unknown,
  stream: boolean
): Request {
  const payload = { ...(body as Record<string, unknown>), stream };
  return new Request(routerUrl(env, path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.ROUTER_KEY}`,
    },
    body: JSON.stringify(payload),
  });
}

/**
 * One router call: through the ROUTER service binding when the worker has it,
 * otherwise over the network. Never sets a tier header. `signal` is optional and
 * comes from the caller, so each call site keeps its own visible timeout, and it
 * travels in the init on whichever path is taken.
 */
export async function fetchRouter(
  env: Env,
  path: string,
  body: unknown,
  stream: boolean,
  signal?: AbortSignal
): Promise<Response> {
  const request = routerRequest(env, path, body, stream);
  const init = signal ? { signal } : {};
  return env.ROUTER ? env.ROUTER.fetch(request, init) : fetch(request, init);
}
