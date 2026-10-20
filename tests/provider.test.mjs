// Unit tests for src/provider.ts: the AI SDK must reach the router service
// binding at the absolute URL it was configured with, carrying the bearer the
// SDK set (or the router key when it set none). Plain Node: `node tests/provider.test.mjs`.
// Silent on success (exit 0). Prints every failure and exits 1 otherwise.

import assert from "node:assert/strict";
import {
  routerFetch,
  createPrimaryModel,
  createCheapModel,
} from "../src/provider.ts";
import { routerUrl } from "../src/router.ts";
import { DEFAULT_MODEL_CHEAP, DEFAULT_MODEL_PRIMARY } from "../src/types.ts";

const FULL = "https://r.example.com/v1/chat/completions";
const PATH = "/v1/chat/completions";
const failures = [];

function record(name, err) {
  failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
}

async function checkAsync(name, fn) {
  try {
    await fn();
  } catch (err) {
    record(name, err);
  }
}

function bindingEnv(seen) {
  return {
    ROUTER_URL: FULL,
    ROUTER_KEY: "test-key",
    ROUTER: {
      fetch: async (req, init) => {
        seen.push({ req, init });
        return new Response("bound");
      },
    },
  };
}

// The SDK never passes a bare path; it concatenates baseURL + "/chat/completions".
// Testing only the bare path would bless a wrapper the provider cannot use.
await checkAsync("routerFetch sends an absolute URL through the binding", async () => {
  const seen = [];
  const env = bindingEnv(seen);
  const res = await routerFetch(env)(routerUrl(env, PATH), { method: "POST", body: "{}" });
  assert.equal(await res.text(), "bound");
  assert.equal(seen.length, 1, "expected exactly one binding call");
});

await checkAsync("the binding receives the configured endpoint unchanged", async () => {
  const seen = [];
  const env = bindingEnv(seen);
  await routerFetch(env)(routerUrl(env, PATH), { method: "POST", body: "{}" });
  assert.equal(seen[0].req.url, FULL, "routerUrl is idempotent, so the URL must not move");
});

await checkAsync("authorization from the SDK is preserved, not replaced", async () => {
  const seen = [];
  const env = bindingEnv(seen);
  await routerFetch(env)(FULL, {
    method: "POST",
    headers: { authorization: "Bearer sdk-key", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(seen[0].req.headers.get("authorization"), "Bearer sdk-key");
  assert.equal(seen[0].req.headers.get("content-type"), "application/json");
});

await checkAsync("the router key is stamped when the SDK sent no authorization", async () => {
  const seen = [];
  const env = bindingEnv(seen);
  await routerFetch(env)(FULL, { method: "POST", body: "{}" });
  assert.equal(seen[0].req.headers.get("authorization"), "Bearer test-key");
});

await checkAsync("the caller's signal reaches the binding's init", async () => {
  const seen = [];
  const env = bindingEnv(seen);
  const ctrl = new AbortController();
  await routerFetch(env)(FULL, { method: "POST", body: "{}", signal: ctrl.signal });
  assert.equal(seen[0].init?.signal, ctrl.signal, "signal absent from binding init");
});

await checkAsync("with no binding it falls through to the global fetch", async () => {
  const env = { ROUTER_URL: FULL, ROUTER_KEY: "test-key" };
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input, init) => {
    seen.push({ input, init });
    return new Response("network");
  };
  try {
    const res = await routerFetch(env)(FULL, { method: "POST", body: "{}" });
    assert.equal(await res.text(), "network");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen.length, 1, "expected exactly one global fetch call");
  assert.equal(seen[0].input.url, FULL);
});

// The factory wiring: provider name, model id, and the v4 spec the harness needs.
await checkAsync("createPrimaryModel builds a zay-router v4 model", async () => {
  const env = { ROUTER_URL: FULL, ROUTER_KEY: "test-key" };
  const model = createPrimaryModel(env);
  assert.equal(model.specificationVersion, "v4");
  assert.equal(model.provider, "zay-router.chat");
  assert.equal(model.modelId, DEFAULT_MODEL_PRIMARY);
});

await checkAsync("model ids come from env when set, defaults otherwise", async () => {
  const env = { ROUTER_URL: FULL, ROUTER_KEY: "test-key", MODEL_PRIMARY: "p-x", MODEL_CHEAP: "c-y" };
  assert.equal(createPrimaryModel(env).modelId, "p-x");
  assert.equal(createCheapModel(env).modelId, "c-y");
  assert.equal(createCheapModel({ ROUTER_URL: FULL, ROUTER_KEY: "k" }).modelId, DEFAULT_MODEL_CHEAP);
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`provider: ${failures.length} failed`);
  process.exit(1);
}
