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

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`router: ${failures.length} failed`);
  process.exit(1);
}
