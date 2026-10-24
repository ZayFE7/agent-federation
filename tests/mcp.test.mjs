// MCP route contract: auth, URL validation, the callback hop, and the calls the
// worker forwards to the main Durable Object. Plain Node.

import assert from "node:assert/strict";
import { handleMcp } from "../src/mcp-routes.ts";

const failures = [];
const calls = [];
const stub = {
  async mcpServers() {
    return {
      servers: [
        { id: "mcp_one", name: "One", url: "https://one.test/mcp", state: "ready", error: null, toolCount: 1, authUrl: null },
      ],
      tools: [
        { serverId: "mcp_one", serverName: "One", name: "read", description: "Read", params: "" },
      ],
    };
  },
  async mcpAdd(name, url, headers, origin) {
    calls.push({ method: "mcpAdd", name, url, headers, origin });
    return { ok: true, id: "mcp_new", state: "ready" };
  },
  async mcpRemove(id) {
    calls.push({ method: "mcpRemove", id });
    return id === "mcp_one";
  },
  async mcpReconnect(id) {
    calls.push({ method: "mcpReconnect", id });
    return { ok: true, state: "ready" };
  },
  async mcpCall(server, tool, input) {
    calls.push({ method: "mcpCall", server, tool, input });
    return "tool output";
  },
  async fetch(request) {
    calls.push({ method: "fetch", path: new URL(request.url).pathname });
    return new Response("callback");
  },
};
const env = {
  AGENT_API_KEY: "test-key",
  FEDERATION_AGENT: {
    idFromName: (name) => ({ name }),
    get: () => stub,
  },
};

function req(path, method = "GET", body, auth = true) {
  return new Request("https://blip.test" + path, {
    method,
    headers: {
      ...(auth ? { authorization: "Bearer test-key" } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function check(name, fn) {
  try {
    await fn();
    console.log("  PASS " + name);
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
    console.log("  FAIL " + name);
  }
}

await check("MCP routes reject an unauthenticated management request", async () => {
  const res = await handleMcp(req("/api/mcp/servers", "GET", undefined, false), env);
  assert.equal(res.status, 401);
});

await check("the OAuth callback is forwarded without the agent bearer", async () => {
  const res = await handleMcp(
    new Request("https://blip.test/api/mcp/callback?code=x&state=y"),
    env
  );
  assert.equal(await res.text(), "callback");
  assert.deepEqual(calls.at(-1), { method: "fetch", path: "/api/mcp/callback" });
});

await check("adding a server rejects non-public HTTPS URLs", async () => {
  for (const url of ["http://example.com/mcp", "https://localhost/mcp", "https://127.0.0.1/mcp"]) {
    const res = await handleMcp(
      req("/api/mcp/servers", "POST", { name: "Bad", url }),
      env
    );
    assert.equal(res.status, 400, url);
  }
});

await check("adding a server forwards URL, headers and origin", async () => {
  const res = await handleMcp(
    req("/api/mcp/servers", "POST", {
      name: "One",
      url: "https://one.test/mcp",
      headers: { Authorization: "Bearer x" },
    }),
    env
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.id, "mcp_new");
  assert.deepEqual(calls.at(-1), {
    method: "mcpAdd",
    name: "One",
    url: "https://one.test/mcp",
    headers: { Authorization: "Bearer x" },
    origin: "https://blip.test",
  });
});

await check("list, reconnect, call and delete reach the main DO", async () => {
  const list = await handleMcp(req("/api/mcp/servers"), env);
  const listBody = await list.json();
  assert.equal(listBody.servers[0].name, "One");

  const reconnect = await handleMcp(req("/api/mcp/servers/mcp_one/reconnect", "POST"), env);
  assert.equal(reconnect.status, 200);

  const called = await handleMcp(
    req("/api/mcp/call", "POST", {
      server: "mcp_one",
      tool: "read",
      arguments: { id: 1 },
    }),
    env
  );
  assert.deepEqual(await called.json(), { ok: true, output: "tool output" });

  const removed = await handleMcp(req("/api/mcp/servers/mcp_one", "DELETE"), env);
  assert.equal(removed.status, 200);
  assert.equal(calls.filter((c) => c.method === "mcpCall").length, 1);
});

if (failures.length) {
  for (const failure of failures) console.error("  FAIL " + failure);
  process.exit(1);
}
console.log("mcp: passed");
