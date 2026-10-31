// Google connection routes: owner bearer for management, public state-protected
// callback, and no token material in any response.

import assert from "node:assert/strict";
import { handleGoogleConnections } from "../src/gmail-routes.ts";

const failures = [];
async function checkAsync(name, fn) {
  try {
    await fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

function account(overrides = {}) {
  return {
    id: "ga_abc12345",
    email: "owner@example.com",
    name: "Owner",
    picture: null,
    is_default: true,
    status: "active",
    scopes: ["https://mail.google.com/"],
    last_error: null,
    last_refresh_at: 1,
    created_at: 1,
    ...overrides,
  };
}

function fixture() {
  const calls = [];
  const stub = {
    calls,
    async googleBegin(origin, loginHint) {
      calls.push(["begin", origin, loginHint]);
      return { ok: true, authUrl: "https://accounts.google.com/oauth?state=s1", redirectUri: `${origin}/api/connections/google/callback` };
    },
    async googleStatus(origin) {
      calls.push(["status", origin]);
      return { configured: true, redirectUri: `${origin}/api/connections/google/callback`, accounts: 1, defaultEmail: "owner@example.com" };
    },
    async googleComplete(code, state) {
      calls.push(["complete", code, state]);
      if (state === "bad") return { ok: false, error: "state_expired" };
      return { ok: true, account: account() };
    },
    async googleAccounts() {
      calls.push(["accounts"]);
      return [account()];
    },
    async googleSetDefault(id) {
      calls.push(["default", id]);
      return id === "ga_abc12345";
    },
    async googleDelete(id) {
      calls.push(["delete", id]);
      return id === "ga_abc12345";
    },
  };
  const env = {
    AGENT_API_KEY: "owner-key",
    REGISTRY: { idFromName: (name) => name, get: () => stub },
  };
  return { env, stub, calls };
}

function request(path, init = {}) {
  return new Request(`https://blip.test${path}`, init);
}
const auth = { authorization: "Bearer owner-key" };

await checkAsync("management routes require the owner bearer", async () => {
  const { env } = fixture();
  assert.equal((await handleGoogleConnections(request("/api/connections/google/accounts"), env)).status, 401);
  assert.equal((await handleGoogleConnections(request("/api/connections/google/start"), env)).status, 401);
});

await checkAsync("start returns the Google URL and exact redirect, with login hint", async () => {
  const { env, calls } = fixture();
  const res = await handleGoogleConnections(
    request("/api/connections/google/start?login_hint=owner%40example.com", { headers: auth }),
    env
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.authUrl, /^https:\/\/accounts\.google\.com/);
  assert.equal(body.redirectUri, "https://blip.test/api/connections/google/callback");
  assert.deepEqual(calls[0], ["begin", "https://blip.test", "owner@example.com"]);
});

await checkAsync("accounts and status expose no token fields", async () => {
  const { env } = fixture();
  const accounts = await handleGoogleConnections(request("/api/connections/google/accounts", { headers: auth }), env);
  const listBody = await accounts.json();
  assert.equal(listBody.accounts[0].email, "owner@example.com");
  assert.equal(JSON.stringify(listBody).includes("refresh_enc"), false);
  assert.equal(JSON.stringify(listBody).includes("access_token"), false);
  assert.equal(JSON.stringify(listBody).includes("accessToken"), false);
  const status = await handleGoogleConnections(request("/api/connections/google/status", { headers: auth }), env);
  assert.equal((await status.json()).configured, true);
});

await checkAsync("default and delete validate ids", async () => {
  const { env, calls } = fixture();
  const ok = await handleGoogleConnections(
    request("/api/connections/google/default", {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ id: "ga_abc12345" }),
    }),
    env
  );
  assert.equal(ok.status, 200);
  const bad = await handleGoogleConnections(
    request("/api/connections/google/default", {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ id: "../bad" }),
    }),
    env
  );
  assert.equal(bad.status, 400);
  const del = await handleGoogleConnections(
    request("/api/connections/google/accounts/ga_abc12345", { method: "DELETE", headers: auth }),
    env
  );
  assert.equal(del.status, 200);
  assert.ok(calls.some((call) => call[0] === "delete"));
});

await checkAsync("callback is public, state-protected and redirects without tokens", async () => {
  const { env } = fixture();
  const ok = await handleGoogleConnections(
    request("/api/connections/google/callback?code=code1&state=good"),
    env
  );
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get("location"), "https://blip.test/?google=connected");
  const bad = await handleGoogleConnections(
    request("/api/connections/google/callback?code=code1&state=bad"),
    env
  );
  assert.equal(bad.status, 302);
  assert.match(bad.headers.get("location"), /google=error/);
  const denied = await handleGoogleConnections(
    request("/api/connections/google/callback?error=access_denied"),
    env
  );
  assert.equal(denied.status, 302);
  assert.match(denied.headers.get("location"), /access_denied/);
});

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log("gmail routes: passed");
