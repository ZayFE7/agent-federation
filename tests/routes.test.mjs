// Contract tests for src/routes.ts: the worker-side /api/sessions* family and the
// session-scoped DO addressing that goes with it (plan Task 7).
//
// This is the file that keeps src/routes.ts honest about WHY it exists as its own
// module: src/index.ts value-imports ./agent, src/agent.ts value-imports `agents`,
// and `agents` pulls in `cloudflare:workers`, which plain Node cannot resolve. So
// the very act of importing handleFetch here is the first half of the proof, and
// the source-scan check below is the second half: routes.ts may value-import only
// dependency-free modules (./auth, ./registry-input, ./registry-store) and must
// take both DO namespaces from the env argument instead of importing the classes.
//
// Plain Node, no framework, no build step: run with `node tests/routes.test.mjs`.
// Silent on success (exit 0). Prints every failure and exits 1 otherwise.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from "../src/registry-input.ts";
import { PLACEHOLDER_TITLE } from "../src/registry-store.ts";
import { agentStubFor, handleFetch } from "../src/routes.ts";
import { authed, safeEq } from "../src/auth.ts";

const failures = [];
const here = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const ROUTES_SOURCE = here("routes.ts");
const AUTH_SOURCE = here("auth.ts");
const INDEX_SOURCE = here("index.ts");
const AGENT_SOURCE = here("agent.ts");
const TYPES_SOURCE = here("types.ts");

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

function checkAsync(name, fn) {
  return fn().catch((err) => {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  });
}

// ---------------------------------------------------------------- fixtures ----

/** Every recorded call a route can make on the registry DO, in call order. */
function fakeRegistry(rows = []) {
  const calls = [];
  const touchCalls = [];
  const regNames = [];
  const stub = {
    calls,
    touchCalls,
    regNames,
    rows,
    async list(limit) {
      calls.push(["list", limit]);
      // A real list is already clamped by the DO; the fixture answers the number
      // of rows the test needs so `truncated` is observable.
      return stub.rows.slice(0, limit).map((row) => ({ ...row }));
    },
    async put(row) {
      calls.push(["put", row]);
    },
    async rename(id, title) {
      calls.push(["rename", id, title]);
    },
    async remove(id) {
      calls.push(["remove", id]);
    },
    // Two declared parameters on purpose: an omitted second argument records as
    // ["abc", undefined], which is what pins "touch(id) with NO opts".
    async touch(id, opts) {
      calls.push(["touch", id, opts]);
      touchCalls.push([id, opts]);
    },
  };
  return stub;
}

/** Fake DurableObjectNamespace for FederationAgent, recording the names it is asked to resolve. */
function fakeAgentNamespace() {
  const names = [];
  const addressed = [];
  const chats = [];
  const messageCalls = [];
  const stubs = new Map();
  const ns = {
    names,
    addressed,
    chats,
    messageCalls,
    reply: { reply: "pong" },
    messageRows: [],
    idFromName(name) {
      names.push(name);
      return { __sessionName: name, toString: () => `do:${name}` };
    },
    get(id) {
      const name = id && id.__sessionName;
      addressed.push(name);
      if (!stubs.has(name)) {
        stubs.set(name, {
          // Rest args record the EXACT arity the caller used, which is what
          // keeps `chat(content, tier)` from silently growing a session id.
          async chat(...args) {
            chats.push({ name, args, arity: args.length });
            return ns.reply;
          },
          async messages(...args) {
            messageCalls.push({ name, args, arity: args.length });
            return ns.messageRows.map((row) => ({ ...row }));
          },
        });
      }
      return stubs.get(name);
    },
  };
  return ns;
}

function fakeEnv({ key = "k", registry, agent } = {}) {
  const registryNames = [];
  return {
    AGENT_API_KEY: key,
    STATE_KEY: "",
    SBOX_TOKEN: "",
    FEDERATION_AGENT: agent,
    REGISTRY: {
      registryNames,
      idFromName(name) {
        registryNames.push(name);
        return { __registryName: name, toString: () => `registry:${name}` };
      },
      get() {
        return registry;
      },
    },
  };
}

function setup({ key = "k", rows = [], agent } = {}) {
  const registry = fakeRegistry(rows);
  const fed = agent || fakeAgentNamespace();
  const env = fakeEnv({ key, registry, agent: fed });
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return { registry, fed, env, ctx };
}

const AUTH = { authorization: "Bearer k" };

const req = (path, method = "GET", { body, headers = AUTH } = {}) =>
  new Request(`https://blip.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });

// ------------------------------------------------------------------ source ----

/**
 * Drops comment lines, so prose never reads as code to the scans below.
 *
 * Line-oriented on purpose. A character-wise block-comment regex would read the
 * star-slash pair inside a doc line mentioning the vault wildcard path as the start
 * of a comment, and would then eat every import underneath it: the guard would pass
 * for the wrong reasons, which is the one failure mode a guard must not have.
 */
function stripComments(source) {
  let inBlock = false;
  const kept = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes("*/")) inBlock = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlock = true;
      continue;
    }
    if (trimmed.startsWith("//")) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * Splits every `import ... from "..."` out of a module into { typeOnly, specifier }.
 * Anchored to a line start: a doc block saying "this module may import nothing but
 * types" would otherwise match lazily all the way to the next real `from "..."` and
 * report a false value import.
 */
function importsOf(source) {
  const out = [];
  const re = /^[ \t]*import\s+(type\s+)?[\s\S]*?from\s*["']([^"']+)["']/gm;
  let match;
  while ((match = re.exec(stripComments(source))) !== null) {
    out.push({ typeOnly: Boolean(match[1]), specifier: match[2] });
  }
  return out;
}

// Specifiers that would make `node tests/routes.test.mjs` die on import, because
// each one reaches the Agents SDK / cloudflare:workers. `./registry` is on the list
// because RegistryAgent value-imports `agents`: importing it here for one type would
// break the offline suite exactly the way `./agent` would, and the types routes.ts
// needs live in src/types.ts for that reason (R39).
const POISONED = new Set([
  "agents",
  "cloudflare:workers",
  "./agent",
  "../agent",
  "./index",
  "./registry",
]);

check("src/routes.ts is importable offline: no non-type import of ./agent or agents", () => {
  const imports = importsOf(ROUTES_SOURCE);
  assert.ok(imports.length > 0, "routes.ts should import something");
  for (const imp of imports) {
    if (imp.typeOnly) continue;
    // routes.ts's value imports carry their `.ts` extension, because plain Node is a
    // strict ESM resolver, so the extension is normalised away before the compare.
    const specifier = imp.specifier.replace(/\.(?:ts|mts|js|mjs)$/, "");
    assert.ok(
      !POISONED.has(specifier),
      `value-import of ${JSON.stringify(imp.specifier)} would pull cloudflare:workers into the offline test`
    );
  }
  // A side-effect import (`import "./agent";`) has no `from` clause and would slip
  // past the scan above.
  assert.equal(
    /^[ \t]*import\s*["'](agents|cloudflare:workers|\.\/agent|\.\/index|\.\/registry)(?:\.(?:ts|mts|js|mjs))?["']/m.test(
      stripComments(ROUTES_SOURCE)
    ),
    false,
    "a bare side-effect import of an SDK-reaching module is still a value import"
  );
});

check("src/routes.ts addresses DOs through env, never through an imported class", () => {
  assert.equal(/\bnew\s+(FederationAgent|RegistryAgent)\b/.test(ROUTES_SOURCE), false);
  assert.equal(/class\s+\w+\s+extends\s+(Agent|FederationAgent|RegistryAgent)\b/.test(ROUTES_SOURCE), false);
  assert.ok(
    /env\.FEDERATION_AGENT\b/.test(ROUTES_SOURCE) && /env\.REGISTRY\b/.test(ROUTES_SOURCE),
    "both namespaces must come from the env argument"
  );
});

// ----------------------------------------------------- src/auth.ts (Produced) ----

// Task 7 MOVES `safeEq`/`authed` out of src/index.ts rather than copying them, so
// the pair has one home that both the worker and an offline test can reach. The
// behaviour itself is exercised by every 401 assertion below; these checks pin the
// move, which nothing else can test (src/index.ts cannot be imported).
check("src/auth.ts exports safeEq and authed with the moved behaviour", () => {
  assert.equal(typeof safeEq, "function");
  assert.equal(typeof authed, "function");
  assert.equal(safeEq("k", "k"), true);
  assert.equal(safeEq("k", "x"), false);
  // Length differs: constant-time compare still answers false without a loop.
  assert.equal(safeEq("k", "kk"), false);
  assert.equal(safeEq("", ""), true);
  assert.equal(
    new Set(importsOf(AUTH_SOURCE).filter((i) => !i.typeOnly)).size,
    0,
    "src/auth.ts must stay dependency-free: it is the only place a test can reach these from"
  );
});

check("src/auth.ts's authed fails closed and reads the bearer token", () => {
  const bearer = (v) => new Request("https://blip.test/x", { headers: v });
  assert.equal(authed(bearer({ authorization: "Bearer k" }), { AGENT_API_KEY: "k" }), true);
  assert.equal(authed(bearer({ authorization: "Bearer wrong" }), { AGENT_API_KEY: "k" }), false);
  assert.equal(authed(bearer({}), { AGENT_API_KEY: "k" }), false);
  // Fail closed: an unset or blank key rejects even a request carrying a token,
  // and a bare "Bearer undefined" no longer authenticates.
  assert.equal(authed(bearer({ authorization: "Bearer k" }), { AGENT_API_KEY: "" }), false);
  assert.equal(authed(bearer({ authorization: "Bearer k" }), {}), false);
  assert.equal(
    authed(bearer({ authorization: "Bearer undefined" }), { AGENT_API_KEY: "undefined" }),
    true,
    "the token is trimmed of the scheme only; the key compare is the gate"
  );
});

check("src/index.ts no longer declares safeEq or authed and imports them from ./auth", () => {
  assert.equal(
    /function\s+(safeEq|authed)\s*\(/.test(INDEX_SOURCE),
    false,
    "two copies of the auth gate is the failure this move exists to prevent"
  );
  const valueImports = importsOf(INDEX_SOURCE)
    .filter((i) => !i.typeOnly)
    .map((i) => i.specifier);
  assert.ok(valueImports.includes("./auth"), "src/index.ts must import the helpers it no longer owns");
  assert.ok(valueImports.includes("./routes"), "src/index.ts must delegate to src/routes.ts");
});

// The R42 rule: src/routes.ts owns the /api/sessions* family ONLY, and src/index.ts
// keeps /api/message, /api/tasks, /api/approve, /api/decide, the WS upgrade and the
// six /internal/vault/* handlers. If index.ts handed over all of /api/* the four live
// routes would die, so the delegation has to be prefix-scoped.
check("src/index.ts delegates the /api/sessions* family and nothing else", () => {
  assert.ok(
    /handleFetch\(/.test(INDEX_SOURCE),
    "index.ts's fetch must call handleFetch"
  );
  assert.ok(
    /(===|==)\s*["']\/api\/sessions["']|startsWith\(["']\/api\/sessions\/["']\)/.test(INDEX_SOURCE),
    "the delegation must be gated on the /api/sessions prefix, not on /api"
  );
  assert.equal(
    /startsWith\(["']\/api["']\)/.test(INDEX_SOURCE),
    false,
    "delegating all of /api/* is the R42 defect"
  );
  for (const kept of ["/api/message", "/api/tasks", "/api/approve", "/api/decide", "/internal/vault/push", "/internal/vault/chunk", "/internal/vault/pull", "/internal/vault/health", "/internal/vault"]) {
    assert.ok(
      INDEX_SOURCE.includes(`"${kept}"`),
      `${kept} must keep its existing handler in src/index.ts (R42)`
    );
  }
});

// The one RPC this task adds to src/agent.ts, and the AgentStub widening that goes
// with it. src/agent.ts cannot be imported by Node, so tsc plus this text check is
// the only check it gets; the brief states the body verbatim.
check("src/agent.ts gains exactly the messages RPC the brief states", () => {
  // Anchored on the one meaningful substring, not on the whole multi-line block: a
  // formatter reflow of src/agent.ts must not fail a behaviour test for a cosmetic
  // reason. The signature half stays checked, with \s* between its tokens.
  assert.ok(
    /async\s+messages\s*\(\s*limit\?:\s*number\s*\)\s*:\s*Promise<MessageRow\[\]>\s*\{/.test(
      AGENT_SOURCE
    ),
    "src/agent.ts must declare async messages(limit?: number): Promise<MessageRow[]>"
  );
  assert.ok(
    AGENT_SOURCE.includes("recentMessages(this.db(), limit ?? 50)"),
    "messages(limit?) must be recentMessages(this.db(), limit ?? 50) and nothing else"
  );
  assert.ok(
    /messages\(\s*limit\?:\s*number\s*\)\s*:\s*Promise<MessageRow\[\]>/.test(TYPES_SOURCE),
    "AgentStub must declare messages(limit?): Promise<MessageRow[]> (R59)"
  );
});

// ------------------------------------------------------- agentStubFor (R38) ----

check("agentStubFor resolves the bare id as the DO name, with no prefix", () => {
  const fed = fakeAgentNamespace();
  const { env } = setup({ agent: fed });
  const stub = agentStubFor(env, "abc");
  assert.deepEqual(fed.names, ["abc"], "idFromName must receive the bare session id (R38)");
  assert.deepEqual(fed.addressed, ["abc"], "get() must receive the id resolved from that name");
  assert.equal(typeof stub.chat, "function");
  assert.equal(typeof stub.messages, "function");
  // The legacy conversation stays reachable as a session, addressed exactly as
  // src/index.ts:84 addresses it today.
  agentStubFor(env, "main");
  assert.deepEqual(fed.names, ["abc", "main"], "main is a session id, not a special case");
});

// ------------------------------------------------------- POST /api/sessions ----

await checkAsync("POST /api/sessions with no auth is 401 and writes nothing", async () => {
  const world = setup();
  const res = await handleFetch(
    req("/api/sessions", "POST", { headers: {} }),
    world.env,
    world.ctx
  );
  assert.equal(res.status, 401);
  assert.deepEqual(world.registry.calls, [], "an unauthorized create must not reach the registry");
});

await checkAsync("POST /api/sessions creates a 26-char id and puts a complete row", async () => {
  const world = setup();
  const res = await handleFetch(req("/api/sessions", "POST"), world.env, world.ctx);
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(Object.keys(body).sort(), ["ok", "session"], "create is {ok, session} and nothing else");
  assert.equal(typeof body.session?.id, "string");
  assert.equal(body.session.id.length, 26, "session ids are the Cloudflare DO name length");
  assert.equal(body.session.id.includes("-"), false, "the uuid dashes are stripped");
  assert.match(body.session.id, /^[0-9a-f]{26}$/);

  const puts = world.registry.calls.filter(([m]) => m === "put");
  assert.equal(puts.length, 1, "exactly one registry.put");
  const row = puts[0][1];
  assert.equal(row.id, body.session.id, "the row stored is the row returned");
  assert.deepEqual(body.session, row, "the response carries the stored row, not a summary of it");
  // title TEXT NOT NULL: nothing else in the plan fills these columns.
  assert.equal(row.title, PLACEHOLDER_TITLE);
  assert.equal(row.unread, 0);
  assert.equal(row.pinned, 0);
  assert.equal(row.workspace_ref, null);
  assert.equal(typeof row.created_at, "number");
  assert.equal(typeof row.updated_at, "number");
  assert.ok(Number.isFinite(row.created_at) && row.created_at > 0, "created_at must be filled");
  assert.ok(Number.isFinite(row.updated_at) && row.updated_at > 0, "updated_at must be filled");
  assert.deepEqual(Object.keys(row).sort(), [
    "created_at",
    "id",
    "pinned",
    "title",
    "unread",
    "updated_at",
    "workspace_ref",
  ]);
  // The registry DO is the single instance Task 6 addresses it by.
  assert.deepEqual(world.env.REGISTRY.registryNames, ["registry"]);
});

await checkAsync("POST /api/sessions ignores a body it does not need but rejects garbage", async () => {
  const world = setup();
  const res = await handleFetch(
    req("/api/sessions", "POST", { body: "{ not json" }),
    world.env,
    world.ctx
  );
  assert.equal(res.status, 400, "a malformed body is 400 even when the route fills every column");
  assert.deepEqual(world.registry.calls, [], "a rejected create must not reach the registry");
});

// --------------------------------------------------------- GET /api/sessions ----

await checkAsync("GET /api/sessions returns the registry list with a 50 default", async () => {
  const rows = [
    { id: "main", title: "New session", created_at: 1, updated_at: 3, workspace_ref: null, unread: 0, pinned: 0 },
    { id: "abc", title: "Drafts", created_at: 2, updated_at: 5, workspace_ref: null, unread: 0, pinned: 1 },
  ];
  const world = setup({ rows });
  const res = await handleFetch(req("/api/sessions"), world.env, world.ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.sessions, rows, "the rows come back as the registry returned them");
  assert.deepEqual(body.sessions[0].title, "New session");
  const lists = world.registry.calls.filter(([m]) => m === "list");
  assert.equal(lists.length, 1);
  assert.equal(lists[0][1], DEFAULT_LIMIT, "the list defaults to 50");
  assert.equal(body.truncated, false, "two rows under a limit of 50 is not truncation");
});

await checkAsync("GET /api/sessions?limit=99999 is clamped to MAX_LIMIT", async () => {
  const world = setup();
  const res = await handleFetch(req("/api/sessions?limit=99999"), world.env, world.ctx);
  assert.equal(res.status, 200);
  const lists = world.registry.calls.filter(([m]) => m === "list");
  assert.equal(lists[0][1], MAX_LIMIT, `limit must clamp at ${MAX_LIMIT}`);
  assert.equal(lists[0][1], 200, "the ceiling is the registry's number, not a restated one");
});

await checkAsync("GET /api/sessions sets truncated when the store returns exactly the limit", async () => {
  const rows = Array.from({ length: 2 }, (_, i) => ({
    id: `s${i}`,
    title: "New session",
    created_at: i,
    updated_at: i,
    workspace_ref: null,
    unread: 0,
    pinned: 0,
  }));
  const world = setup({ rows });
  const res = await handleFetch(req("/api/sessions?limit=2"), world.env, world.ctx);
  const body = await res.json();
  assert.equal(body.sessions.length, 2);
  assert.equal(body.truncated, true, "exactly-limit rows means there is probably more");
  assert.equal(typeof body.truncated, "boolean", "truncated is always a boolean, not absent");
  assert.deepEqual(
    Object.keys(body).sort(),
    ["ok", "sessions", "truncated"],
    "the list response is exactly {ok, sessions, truncated}"
  );
});

await checkAsync("GET /api/sessions with an empty key is 401", async () => {
  const world = setup({ key: "" });
  const res = await handleFetch(req("/api/sessions"), world.env, world.ctx);
  assert.equal(res.status, 401);
  assert.deepEqual(world.registry.calls, []);
});

// ---------------------------------------------------- PATCH/GET/DELETE /:id ----

await checkAsync("PATCH /api/sessions/abc renames with the id and the title", async () => {
  const world = setup();
  const res = await handleFetch(
    req("/api/sessions/abc", "PATCH", { body: JSON.stringify({ title: "New" }) }),
    world.env,
    world.ctx
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(
    world.registry.calls.filter(([m]) => m === "rename"),
    [["rename", "abc", "New"]]
  );
  // R37: a rename deliberately does NOT bump updated_at, so the send route stays
  // the only toucher.
  assert.deepEqual(world.registry.touchCalls, [], "rename must not touch");
});

await checkAsync("PATCH /api/sessions/abc with a missing or blank title is 400", async () => {
  for (const body of ['{"other":1}', '{"title":""}', '{"title":"   "}', "{oops", "null", "[]"]) {
    const world = setup();
    const res = await handleFetch(req("/api/sessions/abc", "PATCH", { body }), world.env, world.ctx);
    assert.equal(res.status, 400, `body ${body} should be rejected`);
    assert.deepEqual(world.registry.calls, [], `body ${body} must not rename`);
  }
});

await checkAsync("DELETE /api/sessions/abc removes the id", async () => {
  const world = setup();
  const res = await handleFetch(req("/api/sessions/abc", "DELETE"), world.env, world.ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(
    world.registry.calls.filter(([m]) => m === "remove"),
    [["remove", "abc"]]
  );
});

// ----------------------------------------------- GET /api/sessions/:id/messages ----

const TRANSCRIPT = [
  { id: 7, role: "user", content: "hi", tier: "cheap", created_at: 1700000000000 },
  { id: 8, role: "assistant", content: "hello", tier: null, created_at: 1700000000500 },
];

await checkAsync("GET /api/sessions/abc/messages returns MessageRow[] unmodified", async () => {
  const world = setup();
  world.fed.messageRows = TRANSCRIPT;
  const res = await handleFetch(req("/api/sessions/abc/messages"), world.env, world.ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.messages, TRANSCRIPT);
  // Nothing mapped MessageRow down to {role, content}: created_at is the field the
  // console groups a transcript by day, and id/tier survive too.
  assert.equal(body.messages[0].created_at, 1700000000000, "created_at must survive the route");
  assert.deepEqual(Object.keys(body.messages[0]).sort(), [
    "content",
    "created_at",
    "id",
    "role",
    "tier",
  ]);
});

await checkAsync("GET /api/sessions/abc/messages clamps ?limit=99999 to MAX_LIMIT", async () => {
  const world = setup();
  await handleFetch(req("/api/sessions/abc/messages?limit=99999"), world.env, world.ctx);
  assert.equal(world.fed.messageCalls.length, 1);
  assert.equal(world.fed.messageCalls[0].args[0], MAX_LIMIT);
  assert.deepEqual(world.fed.messageCalls[0].args, [MAX_LIMIT], "one argument, the clamped limit");
});

await checkAsync("GET /api/sessions/abc/messages passes DEFAULT_LIMIT when ?limit is absent", async () => {
  const world = setup();
  await handleFetch(req("/api/sessions/abc/messages"), world.env, world.ctx);
  assert.equal(world.fed.messageCalls[0].args[0], DEFAULT_LIMIT);
  assert.equal(world.fed.messageCalls[0].name, "abc", "the transcript is read from that session's own DO");
});

await checkAsync("GET /api/sessions/abc/messages reads the session DO, never main", async () => {
  const world = setup();
  await handleFetch(req("/api/sessions/abc/messages"), world.env, world.ctx);
  assert.deepEqual(world.fed.names, ["abc"]);
  assert.equal(world.fed.addressed.includes("main"), false, "R41: no silent fallback to main");
});

// ------------------------------------------------ POST /api/sessions/:id/message ----

await checkAsync("POST /api/sessions/abc/message forwards to the abc DO and not to main", async () => {
  const world = setup();
  const res = await handleFetch(
    req("/api/sessions/abc/message", "POST", { body: JSON.stringify({ content: "say pong" }) }),
    world.env,
    world.ctx
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { reply: "pong" }, "the agent's AgentReply is returned as-is");
  assert.deepEqual(world.fed.names, ["abc"], "the id is the DO name (R38)");
  assert.deepEqual(world.fed.addressed, ["abc"]);
  assert.equal(world.fed.addressed.includes("main"), false, "R41: the send is session-scoped");
  assert.equal(world.fed.chats.length, 1);
});

await checkAsync("the send calls chat(content, tier) with exactly two arguments (R65)", async () => {
  const world = setup();
  await handleFetch(
    req("/api/sessions/abc/message", "POST", {
      body: JSON.stringify({ content: "say pong", tier: "cheap" }),
    }),
    world.env,
    world.ctx
  );
  const call = world.fed.chats[0];
  assert.equal(call.arity, 2, "chat takes no session id in Task 7: the id travels in the DO");
  assert.deepEqual(call.args, ["say pong", "cheap"]);
});

await checkAsync("an absent or unknown tier is passed through as undefined, still two arguments", async () => {
  const world = setup();
  await handleFetch(
    req("/api/sessions/abc/message", "POST", { body: JSON.stringify({ content: "hello" }) }),
    world.env,
    world.ctx
  );
  assert.equal(world.fed.chats[0].arity, 2);
  assert.deepEqual(world.fed.chats[0].args, ["hello", undefined]);
  assert.equal(world.fed.chats[0].args[1], undefined, "no tier means undefined, the same rule as src/index.ts:82");
});

await checkAsync("a successful send touches the registry once with (id, undefined)", async () => {
  const world = setup();
  await handleFetch(
    req("/api/sessions/abc/message", "POST", { body: JSON.stringify({ content: "hello" }) }),
    world.env,
    world.ctx
  );
  assert.deepEqual(
    world.registry.touchCalls,
    [["abc", undefined]],
    "touch(id) with NO opts: bumps updated_at only, and unread is a later phase"
  );
});

await checkAsync("any reply bumps updated_at, including one carrying a code", async () => {
  const world = setup();
  world.fed.reply = { reply: "", code: "still_a_reply" };
  const res = await handleFetch(
    req("/api/sessions/abc/message", "POST", { body: JSON.stringify({ content: "hello" }) }),
    world.env,
    world.ctx
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { reply: "", code: "still_a_reply" });
  assert.deepEqual(world.registry.touchCalls, [["abc", undefined]]);
});

await checkAsync("touch never runs when the send 401s", async () => {
  const world = setup();
  const res = await handleFetch(
    req("/api/sessions/abc/message", "POST", {
      body: JSON.stringify({ content: "hello" }),
      headers: {},
    }),
    world.env,
    world.ctx
  );
  assert.equal(res.status, 401);
  assert.deepEqual(world.registry.touchCalls, []);
  assert.deepEqual(world.registry.calls, []);
  assert.equal(world.fed.chats.length, 0, "an unauthenticated send must not reach the agent");
});

await checkAsync("touch never runs when the body is malformed", async () => {
  for (const body of ["{oops", "{}", '{"content":""}', '{"content":5}', "null"]) {
    const world = setup();
    const res = await handleFetch(
      req("/api/sessions/abc/message", "POST", { body }),
      world.env,
      world.ctx
    );
    assert.equal(res.status, 400, `body ${body} must be a 400`);
    assert.deepEqual(world.registry.touchCalls, [], `body ${body} must not bump updated_at`);
    assert.equal(world.fed.chats.length, 0, `body ${body} must not reach the agent`);
  }
});

await checkAsync("POST /api/sessions/main/message reaches the legacy DO as session main", async () => {
  const world = setup();
  await handleFetch(
    req("/api/sessions/main/message", "POST", { body: JSON.stringify({ content: "hello" }) }),
    world.env,
    world.ctx
  );
  assert.deepEqual(world.fed.names, ["main"], "no prefix and no special case (R38)");
  assert.deepEqual(world.registry.touchCalls, [["main", undefined]]);
});

// ------------------------------------------------------------ auth and shapes ----

await checkAsync("with AGENT_API_KEY empty every session route 401s and nothing is called", async () => {
  const routes = [
    ["/api/sessions", "GET", undefined],
    ["/api/sessions", "POST", undefined],
    ["/api/sessions/abc", "PATCH", JSON.stringify({ title: "New" })],
    ["/api/sessions/abc", "DELETE", undefined],
    ["/api/sessions/abc/messages", "GET", undefined],
    ["/api/sessions/abc/message", "POST", JSON.stringify({ content: "hello" })],
  ];
  for (const [path, method, body] of routes) {
    const world = setup({ key: "" });
    const res = await handleFetch(
      req(path, method, body === undefined ? {} : { body }),
      world.env,
      world.ctx
    );
    assert.equal(res.status, 401, `${method} ${path} must fail closed with no key`);
    assert.deepEqual(world.registry.calls, [], `${method} ${path} must not touch the registry`);
    assert.equal(world.fed.chats.length, 0, `${method} ${path} must not reach the agent`);
    assert.equal(world.fed.messageCalls.length, 0, `${method} ${path} must not read a transcript`);
  }
});

await checkAsync("a wrong bearer token is 401 on the list route", async () => {
  const world = setup();
  const res = await handleFetch(
    req("/api/sessions", "GET", { headers: { authorization: "Bearer wrong" } }),
    world.env,
    world.ctx
  );
  assert.equal(res.status, 401);
});

// The six routes the Interfaces block enumerates are the whole family: a shape, or
// a method on a shape, that is not one of them is a 404. `GET /api/sessions/:id` is
// deliberately NOT one of them: the plan lists no single-session read on the worker
// (the registry DO has one under /registry/, and Task 22 adds /:id/stream/:streamId).
await checkAsync("a path with an unknown shape 404s", async () => {
  for (const [path, method] of [
    ["/api/sessions/abc/nope", "GET"],
    ["/api/sessions/abc/message/extra", "POST"],
    ["/api/sessions/a/b/c", "GET"],
    ["/api/sessions/abc", "GET"],
    ["/api/sessions/abc", "POST"],
    ["/api/sessions", "PUT"],
    ["/api/sessions/abc/messages", "POST"],
    ["/api/sessions/abc/message", "GET"],
    ["/api/sessionsXYZ", "GET"],
    ["/api/message", "POST"],
    ["/api/tasks", "GET"],
  ]) {
    const world = setup();
    const res = await handleFetch(
      req(path, method, method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
      world.env,
      world.ctx
    );
    assert.equal(res.status, 404, `${method} ${path} is not one of the six routes`);
    assert.deepEqual(world.registry.calls, [], `${method} ${path} must not reach the registry`);
    assert.equal(world.fed.chats.length, 0, `${method} ${path} must not reach the agent`);
    assert.equal(world.fed.messageCalls.length, 0, `${method} ${path} must not read a transcript`);
  }
});

await checkAsync("every session response is JSON", async () => {
  const world = setup();
  const res = await handleFetch(req("/api/sessions"), world.env, world.ctx);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
});

// ------------------------------------------------------------------ summary ----

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`routes: ${failures.length} failed`);
  process.exit(1);
}
