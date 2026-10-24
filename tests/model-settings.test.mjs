// Model provider settings: URL and model validation, encrypted keys, the pure
// provider store, and the authenticated settings routes. Plain Node.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  normalizeBaseUrl,
  normalizeModels,
  parseProviderInput,
} from "../src/model-input.ts";
import { parseModelPick } from "../src/registry-input.ts";
import { decryptSecret, encryptSecret, keyHint } from "../src/model-secrets.ts";
import {
  deleteProviderRow,
  ensureModelSchema,
  listProviderRows,
  readModelDefault,
  upsertProviderRow,
  writeModelDefault,
} from "../src/model-store.ts";
import { handleSettings } from "../src/settings-routes.ts";

const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log("  PASS " + name);
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
    console.log("  FAIL " + name);
  }
}

await check("base URL is forced to HTTPS and a /v1 root", () => {
  assert.equal(normalizeBaseUrl("https://api.example.com"), "https://api.example.com/v1");
  assert.equal(
    normalizeBaseUrl("https://api.example.com/v1/chat/completions"),
    "https://api.example.com/v1"
  );
  assert.equal(
    normalizeBaseUrl("https://api.example.com/openai/v1"),
    "https://api.example.com/openai/v1"
  );
  assert.equal(normalizeBaseUrl("http://api.example.com"), null);
  assert.equal(normalizeBaseUrl("https://user:pass@api.example.com"), null);
  assert.equal(normalizeBaseUrl("https://127.0.0.1/v1"), null);
  assert.equal(normalizeBaseUrl("https://localhost/v1"), null);
  assert.equal(normalizeBaseUrl("not a url"), null);
});

await check("model lists are bounded and validated", () => {
  assert.deepEqual(normalizeModels(["a/b", "a/b", "c"]), ["a/b", "c"]);
  assert.equal(normalizeModels([]), null);
  assert.equal(normalizeModels(["../etc/passwd"]), null);
  assert.equal(normalizeModels(["two words"]), null);
  assert.equal(normalizeModels(["x".repeat(200)]), null);
});

await check("provider input requires a name, URL and models", () => {
  const good = parseProviderInput({
    name: "Example",
    baseUrl: "https://api.example.com/v1",
    models: ["a/b"],
    apiKey: "secret",
  });
  assert.equal(good.ok, true);
  assert.equal(good.value.baseUrl, "https://api.example.com/v1");
  assert.equal(good.value.apiKey, "secret");
  assert.equal(parseProviderInput({ name: "", baseUrl: "https://x.test", models: ["a"] }).ok, false);
  assert.equal(parseProviderInput({ name: "x", baseUrl: "http://x.test", models: ["a"] }).ok, false);
  assert.equal(parseProviderInput({ name: "x", baseUrl: "https://x.test", models: [] }).ok, false);
});

await check("provider keys round trip through AES-GCM and never appear in the hint", async () => {
  const payload = await encryptSecret("agent-secret", "sk-live-123456789");
  assert.notEqual(payload, "sk-live-123456789");
  assert.equal(payload.startsWith("v1."), true);
  assert.equal(await decryptSecret("agent-secret", payload), "sk-live-123456789");
  assert.equal(await decryptSecret("another-secret", payload), "");
  assert.equal(await encryptSecret("agent-secret", ""), "");
  assert.equal(keyHint("sk-live-123456789"), "••••6789");
});

await check("per-chat model picks default to the deployment provider", () => {
  assert.deepEqual(parseModelPick({ model: "m1" }), {
    ok: true,
    provider: "deployment",
    model: "m1",
  });
  assert.deepEqual(parseModelPick({ model: "m1", provider: "p_one" }), {
    ok: true,
    provider: "p_one",
    model: "m1",
  });
  assert.deepEqual(parseModelPick({ model: "" }), {
    ok: true,
    provider: "deployment",
    model: null,
  });
  assert.equal(parseModelPick({ model: null }).ok, false);
  assert.equal(parseModelPick({ model: "m1", provider: "two words" }).ok, false);
  assert.equal(parseModelPick({ model: "m1", provider: "P_ONE" }).provider, "p_one");
});

const db = new DatabaseSync(":memory:");
const sql = {
  exec(query, ...bindings) {
    const parts = query.split("?");
    if (parts.length !== bindings.length + 1) throw new Error("placeholder mismatch");
    return { results: db.prepare(parts.join("?")).all(...bindings) };
  },
};

await check("provider store upserts, lists and deletes", () => {
  ensureModelSchema(sql);
  const now = Date.now();
  upsertProviderRow(sql, {
    id: "p_one",
    name: "One",
    base_url: "https://one.test/v1",
    api_key_enc: "v1.iv.cipher",
    models_json: '["m1","m2"]',
    created_at: now,
    updated_at: now,
  });
  const rows = listProviderRows(sql);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "One");
  writeModelDefault(sql, { provider: "p_one", model: "m2" });
  assert.deepEqual(readModelDefault(sql), { provider: "p_one", model: "m2" });
  deleteProviderRow(sql, "p_one");
  assert.deepEqual(listProviderRows(sql), []);
  assert.equal(readModelDefault(sql), null);
});

const saved = {
  providers: [
    {
      id: "p_one",
      name: "One",
      baseUrl: "https://one.test/v1",
      apiKey: "secret-key-1234",
      models: ["m1", "m2"],
    },
  ],
  default: { provider: "p_one", model: "m1" },
};
const writes = [];
const registry = {
  async modelSettings() {
    return saved;
  },
  async saveModelProvider(id, input) {
    writes.push({ id, input });
    return { id: id || "p_new", ...input, apiKey: input.apiKey || "" };
  },
  async deleteModelProvider(id) {
    return id === "p_one";
  },
  async setModelDefault(provider, model) {
    return provider === "p_one" && model === "m1";
  },
};
const env = {
  AGENT_API_KEY: "test-agent-key",
  MODEL_PRIMARY: "deploy/model",
  MODEL_CHEAP: "deploy/model",
  REGISTRY: {
    idFromName: (name) => ({ name }),
    get: () => registry,
  },
};

function authedSettings(path, method = "GET", body) {
  return new Request("https://blip.test" + path, {
    method,
    headers: {
      authorization: "Bearer test-agent-key",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

await check("settings routes reject an unauthenticated request", async () => {
  const res = await handleSettings(
    new Request("https://blip.test/api/settings/models"),
    env
  );
  assert.equal(res.status, 401);
});

await check("GET settings masks every API key", async () => {
  const res = await handleSettings(authedSettings("/api/settings/models"), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  const text = JSON.stringify(body);
  assert.equal(text.includes("secret-key-1234"), false);
  assert.equal(body.providers[0].hasKey, true);
  assert.equal(body.providers[0].keyHint, "••••1234");
  assert.equal(body.deployment.model, "deploy/model");
});

await check("POST provider passes validated input to the registry", async () => {
  const res = await handleSettings(
    authedSettings("/api/settings/providers", "POST", {
      name: "New",
      baseUrl: "https://new.test/v1",
      models: ["n/m"],
      apiKey: "new-secret",
    }),
    env
  );
  assert.equal(res.status, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].input.apiKey, "new-secret");
  const body = await res.json();
  assert.equal(JSON.stringify(body).includes("new-secret"), false);
});

await check("default route rejects an unknown provider or model", async () => {
  const ok = await handleSettings(
    authedSettings("/api/settings/default", "PUT", { provider: "p_one", model: "m1" }),
    env
  );
  assert.equal(ok.status, 200);
  const bad = await handleSettings(
    authedSettings("/api/settings/default", "PUT", { provider: "p_one", model: "m9" }),
    env
  );
  assert.equal(bad.status, 400);
});

if (failures.length) {
  for (const failure of failures) console.error("  FAIL " + failure);
  process.exit(1);
}
console.log(`model settings: ${failures.length === 0 ? "passed" : "failed"}`);
