// Unit tests for the router helpers in src/router.ts: every LLM call must reach
// the ROUTER service binding at exactly one /v1/chat/completions, with no X-Tier.
// Plain Node, no framework: run with `node tests/router.test.mjs`.
// Node 22.6+/24 strips the .ts types on import, so this needs no build step.
// Silent on success (exit 0). Prints every failure and exits 1 otherwise.

import assert from "node:assert/strict";
import { routerUrl, routerRequest, fetchRouter } from "../src/router.ts";

const PATH = "/v1/chat/completions";
const failures = [];

function record(name, err) {
  failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
}

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    record(name, err);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
  } catch (err) {
    record(name, err);
  }
}

// ---- routerUrl: every shape ROUTER_URL actually takes ----
// Row 1 is the one that matters: ROUTER_URL is configured as a complete endpoint,
// not an origin, so appending blindly would 404 every call.
const SHAPES = [
  ["https://h.example/v1/chat/completions", "https://h.example/v1/chat/completions"],
  ["https://h.example/base/", "https://h.example/base/v1/chat/completions"],
  ["https://h.example/v1", "https://h.example/v1/chat/completions"],
  ["https://h.example", "https://h.example/v1/chat/completions"],
];

for (const [configured, expected] of SHAPES) {
  check(`routerUrl(${JSON.stringify(configured)})`, () => {
    assert.equal(routerUrl({ ROUTER_URL: configured }, PATH), expected);
  });
  // Idempotence: applying routerUrl to its own output changes nothing.
  check(`routerUrl(${JSON.stringify(configured)}) is idempotent`, () => {
    const once = routerUrl({ ROUTER_URL: configured }, PATH);
    assert.equal(routerUrl({ ROUTER_URL: once }, PATH), once);
  });
}

check("routerUrl keeps a path prefix and never doubles the endpoint", () => {
  assert.equal(
    routerUrl({ ROUTER_URL: "https://h.example/gateway/v1/chat/completions" }, PATH),
    "https://h.example/gateway/v1/chat/completions"
  );
});

// ---- routerRequest: auth, content type, stream flag, no X-Tier ----
const env = { ROUTER_URL: "https://h.example/v1/chat/completions", ROUTER_KEY: "test-key" };

check("routerRequest builds a POST to the normalized URL with the Bearer key", () => {
  const req = routerRequest(env, PATH, { model: "m" }, true);
  assert.equal(req.method, "POST");
  assert.equal(req.url, "https://h.example/v1/chat/completions");
  assert.equal(req.headers.get("authorization"), "Bearer test-key");
  assert.equal(req.headers.get("content-type"), "application/json");
});

check("routerRequest sends no X-Tier header", () => {
  const req = routerRequest(env, PATH, { model: "m" }, true);
  const names = [...req.headers.keys()];
  assert.equal(
    names.filter((name) => name.toLowerCase() === "x-tier").length,
    0,
    `unexpected tier header among: ${names.join(", ")}`
  );
});

await checkAsync("routerRequest stamps the stream flag into the body", async () => {
  const streamed = JSON.parse(await routerRequest(env, PATH, { model: "m" }, true).text());
  assert.deepEqual(streamed, { model: "m", stream: true });
  const unstreamed = JSON.parse(await routerRequest(env, PATH, { model: "m" }, false).text());
  assert.deepEqual(unstreamed, { model: "m", stream: false });
});

// ---- fetchRouter: prefers the ROUTER service binding over the network fetch ----
await checkAsync("fetchRouter goes through env.ROUTER when the binding exists", async () => {
  const bindingResponse = new Response("ok");
  const seen = [];
  const envWithBinding = {
    ROUTER_URL: "https://h.example/base",
    ROUTER_KEY: "test-key",
    ROUTER: {
      fetch: async (req) => {
        seen.push(req);
        return bindingResponse;
      },
    },
  };
  const res = await fetchRouter(envWithBinding, PATH, { model: "m" }, false);
  assert.equal(seen.length, 1, "expected exactly one binding call");
  assert.equal(res, bindingResponse);
  assert.equal(seen[0].url, "https://h.example/base/v1/chat/completions");
  assert.equal(seen[0].headers.get("authorization"), "Bearer test-key");
  assert.equal(
    [...seen[0].headers.keys()].filter((name) => name.toLowerCase() === "x-tier").length,
    0
  );
});

// ---- the caller's AbortSignal must reach fetch's RequestInit, not the Request ----
// Workers document `signal` on fetch's init and on Fetcher.fetch's init; the Request
// constructor's documented init does not include it, so a signal carried on the
// Request is a silent drop and every call-site timeout becomes inert. Same class as
// the {timeout} vs timeoutMs drop. Pinned on both paths, plus the shape that proves
// the signal is not riding on the Request instead.
await checkAsync("fetchRouter hands the signal to global fetch's init", async () => {
  const ctrl = new AbortController();
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    seen.push({ input, init });
    return new Response("ok");
  };
  try {
    await fetchRouter(env, PATH, { model: "m" }, false, ctrl.signal);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen.length, 1, "expected exactly one fetch call");
  assert.equal(seen[0].init?.signal, ctrl.signal, "signal absent from fetch init");
  assert.notEqual(
    seen[0].input.signal,
    ctrl.signal,
    "signal must not be carried on the Request, where workerd does not read it"
  );
});

await checkAsync("fetchRouter hands the signal to the ROUTER binding's init", async () => {
  const ctrl = new AbortController();
  const seen = [];
  const envWithBinding = {
    ...env,
    ROUTER: {
      fetch: async (req, init) => {
        seen.push({ req, init });
        return new Response("ok");
      },
    },
  };
  await fetchRouter(envWithBinding, PATH, { model: "m" }, false, ctrl.signal);
  assert.equal(seen.length, 1, "expected exactly one binding call");
  assert.equal(seen[0].init?.signal, ctrl.signal, "signal absent from binding init");
  assert.notEqual(seen[0].req.signal, ctrl.signal, "signal must not be on the Request");
});

await checkAsync("fetchRouter rejects against the real fetch on an aborted signal", async () => {
  // No stub: this is the platform's own abort path, and it must reject before any
  // network I/O, which is why an unroutable host is fine here.
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    () => fetchRouter(env, PATH, { model: "m" }, false, ctrl.signal),
    (err) => err?.name === "AbortError",
    "an already-aborted signal must reject with AbortError"
  );
});

await checkAsync("fetchRouter still works with no signal", async () => {
  const realFetch = globalThis.fetch;
  let initSeen = "unset";
  globalThis.fetch = async (input, init) => {
    initSeen = init;
    return new Response("ok");
  };
  try {
    const res = await fetchRouter(env, PATH, { model: "m" }, false);
    assert.equal(await res.text(), "ok");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(
    initSeen === undefined || initSeen?.signal === undefined,
    "no signal must be handed to fetch when the caller passed none"
  );
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`router: ${failures.length} failed`);
  process.exit(1);
}
