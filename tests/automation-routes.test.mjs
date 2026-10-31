// Route contract: public hooks authenticate per automation, management routes
// require the owner bearer, and reserved paths win over the :id branch.

import assert from "node:assert/strict";
import { handleAutomationHooks, handleAutomations } from "../src/automation-routes.ts";

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

function automationRow(extra = {}) {
  return {
    id: "abc12345",
    name: "Issue triage",
    kind: "github",
    enabled: 1,
    target_session_id: "main",
    instructions: "Summarize the issue",
    source_json: '{"type":"webhook","auth":"github"}',
    match_json: null,
    secret_enc: "v1.iv.cipher",
    secret_hint: "abcd",
    cooldown_ms: 10000,
    max_per_hour: 20,
    next_run_at: null,
    last_event_at: null,
    last_run_at: null,
    last_error: null,
    consecutive_failures: 0,
    created_at: 1,
    updated_at: 1,
    ...extra,
  };
}

function fixture() {
  const calls = [];
  const stub = {
    calls,
    async ingestHook(input) {
      calls.push(["ingestHook", input]);
      if (input.automationId === "missing1") return { status: "not_found" };
      if (input.automationId === "large123") return { status: "too_large" };
      if (input.bodyText === "bad") return { status: "invalid", reason: "signature" };
      if (input.bodyText === "dup") return { status: "duplicate", eventId: "e1" };
      if (input.bodyText === "limited") return { status: "rate_limited", eventId: "e2" };
      return { status: "accepted", eventId: "e1" };
    },
    async listAutomations(filter, limit) {
      calls.push(["listAutomations", filter, limit]);
      return [automationRow()];
    },
    async getAutomation(id) {
      calls.push(["getAutomation", id]);
      return id === "abc12345" ? automationRow() : null;
    },
    async automationEvents(id, after, limit) {
      calls.push(["events", id, after, limit]);
      return [];
    },
    async automationRuns(id, limit) {
      calls.push(["runs", id, limit]);
      return [];
    },
    async controlAutomation(id, action, note) {
      calls.push(["control", id, action, note]);
      if (action === "preview") return { ok: true, prompt: "the prompt" };
      if (action === "rotate_secret") return { ok: true, secret: "new-secret" };
      return { ok: true };
    },
    async setGlobalPause(paused) {
      calls.push(["setGlobalPause", paused]);
    },
    async globalPaused() {
      return false;
    },
    async automationAttention(limit) {
      calls.push(["attention", limit]);
      return [];
    },
    async createAutomation(input) {
      calls.push(["create", input]);
      return { ok: true, automation: automationRow(), secret: "s".repeat(43) };
    },
  };
  const env = {
    AGENT_API_KEY: "owner-key",
    AUTOMATION: {
      idFromName: (name) => name,
      get: () => stub,
    },
  };
  return { env, stub, calls };
}

function request(path, init = {}) {
  return new Request(`https://blip.test${path}`, init);
}

const auth = { authorization: "Bearer owner-key" };

await checkAsync("public hooks validate the automation secret path", async () => {
  const { env, calls } = fixture();
  const ok = await handleAutomationHooks(
    request("/hooks/abc12345/secret", { method: "POST", body: "{}" }),
    env
  );
  assert.equal(ok.status, 202);
  assert.equal(calls[0][1].mode, "generic");
  const dup = await handleAutomationHooks(
    request("/hooks/abc12345/secret", { method: "POST", body: "dup" }),
    env
  );
  assert.equal(dup.status, 200);
  const bad = await handleAutomationHooks(
    request("/hooks/abc12345/secret", { method: "POST", body: "bad" }),
    env
  );
  assert.equal(bad.status, 401);
});

await checkAsync("github hook uses header auth without a path secret", async () => {
  const { env, calls } = fixture();
  const res = await handleAutomationHooks(
    request("/hooks/abc12345", {
      method: "POST",
      body: "{}",
      headers: { "x-hub-signature-256": "sha256=abc" },
    }),
    env
  );
  assert.equal(res.status, 202);
  assert.equal(calls[0][1].mode, "github");
  assert.equal(calls[0][1].pathSecret, undefined);
});

await checkAsync("unknown ids, oversized bodies, and rate limits map to clean statuses", async () => {
  const { env } = fixture();
  assert.equal((await handleAutomationHooks(request("/hooks/missing1/x", { method: "POST", body: "{}" }), env)).status, 404);
  assert.equal((await handleAutomationHooks(request("/hooks/large123/x", { method: "POST", body: "{}" }), env)).status, 413);
  assert.equal((await handleAutomationHooks(request("/hooks/abc12345/x", { method: "POST", body: "large", headers: { "content-length": "200000" } }), env)).status, 413);
  assert.equal((await handleAutomationHooks(request("/hooks/abc12345/x", { method: "POST", body: "limited" }), env)).status, 429);
});

await checkAsync("management routes require the owner bearer", async () => {
  const { env } = fixture();
  const res = await handleAutomations(request("/api/automations"), env);
  assert.equal(res.status, 401);
});

await checkAsync("create returns the secret once and never list secrets", async () => {
  const { env, calls } = fixture();
  const res = await handleAutomations(
    request("/api/automations", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Issue triage",
        kind: "github",
        instructions: "Summarize it",
        source: { type: "webhook", auth: "github" },
      }),
    }),
    env
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.secret.length, 43);
  assert.equal(body.webhookPath.includes(body.secret), true);
  assert.equal(calls[0][1].target_session_id, "main");
  const list = await handleAutomations(request("/api/automations", { headers: auth }), env);
  assert.equal(list.status, 200);
  const listBody = await list.json();
  assert.equal(JSON.stringify(listBody).includes("secret_enc"), false);
  assert.equal(JSON.stringify(listBody).includes('"secret"'), false);
});

await checkAsync("reserved paths and control actions are routed before :id", async () => {
  const { env, calls } = fixture();
  assert.equal((await handleAutomations(request("/api/automations/attention", { headers: auth }), env)).status, 200);
  assert.equal(calls.at(-1)[0], "attention");
  assert.equal((await handleAutomations(request("/api/automations/pause-all", { method: "POST", headers: auth }), env)).status, 200);
  assert.equal(calls.at(-1)[0], "setGlobalPause");
  const preview = await handleAutomations(
    request("/api/automations/abc12345/control", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ action: "preview" }),
    }),
    env
  );
  assert.equal((await preview.json()).prompt, "the prompt");
  const bad = await handleAutomations(
    request("/api/automations/abc12345/control", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ action: "delete" }),
    }),
    env
  );
  assert.equal(bad.status, 400);
  const wrongId = await handleAutomations(request("/api/automations/BAD", { headers: auth }), env);
  assert.equal(wrongId.status, 400);
});

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log("automation routes: passed");
