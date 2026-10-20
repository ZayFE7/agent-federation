// Contract tests for src/routes.ts: the worker-side /api/sessions* family and the
// session-scoped DO addressing that goes with it (plan Task 7).
//
// This is the file that keeps src/routes.ts honest about WHY it exists as its own
// module: src/index.ts value-imports ./agent, src/agent.ts value-imports `agents`,
// and `agents` pulls in `cloudflare:workers`, which plain Node cannot resolve. So
// the very act of importing handleFetch here is the first half of the proof, and
// the source-scan check below is the second half: routes.ts may value-import only
// dependency-free modules (./auth, ./registry-input, ./registry-store, and since
// Task 8 the guard itself in ./session-scope, R75) and must take both DO namespaces
// from the env argument instead of importing the classes.
//
// Task 8 also puts the gate ORDER under test: auth 401, then the session-id shape
// 400 (before any idFromName call), then the registry `exists` 404 (before any DO is
// addressed), then the agent, whose refusal reply carries code "invalid_session" and
// answers 403 with no registry touch (R76).
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
    // Gate 3 (R76): the routes ask the index before they address a session DO, so the
    // fixture answers from its own rows instead of always saying yes. An
    // always-true `exists` would leave the 404 branch unprovable, and an always-false
    // one would take every send and every transcript read down with it.
    async exists(id) {
      calls.push(["exists", id]);
      return stub.rows.some((row) => row.id === id);
    },
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
  const fetches = [];
  const stubs = new Map();
  const ns = {
    names,
    addressed,
    chats,
    messageCalls,
    fetches,
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
          // Task 22: the worker forwards the GET stream to the owning DO and never
          // reads a chunk itself, so the recording stub is the whole worker-side
          // contract: which URL, which headers, and whose DO.
          async fetch(request) {
            fetches.push({ name, request });
            return new Response("data: {\"t\":\"done\"}\n\n", {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            });
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

/**
 * The two ids every existing case uses (`abc` for a session, `main` for the legacy
 * DO). Task 8 puts a registry `exists` read in front of every session-DOP address,
 * so a send or a transcript read needs a row to be served at all; a case that wants
 * an absent id passes its own `rows`, or uses an id outside this set.
 */
const DEFAULT_ROWS = () =>
  ["abc", "main"].map((id) => ({
    id,
    title: PLACEHOLDER_TITLE,
    created_at: 1,
    updated_at: 1,
    workspace_ref: null,
    unread: 0,
    pinned: 0,
  }));

function setup({ key = "k", rows = DEFAULT_ROWS(), agent } = {}) {
  const registry = fakeRegistry(rows);
  const fed = agent || fakeAgentNamespace();
  const env = fakeEnv({ key, registry, agent: fed });
  // A recorder, not a no-op: amendment 5 (R73) moves the accepted send's `touch`
  // behind `ctx.waitUntil`, and the promise arriving here is the only way a test can
  // see that the route handed the work over instead of awaiting it.
  const promised = [];
  const ctx = {
    waitUntil(promise) {
      promised.push(promise);
    },
    passThroughOnException() {},
  };
  return { registry, fed, env, ctx, promised };
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

// The deny list above is not the whole rule: `./memory` and `./session-store` are not
// in POISONED, and an import of a module that reaches the SDK later would break this
// file at import time rather than in the scan. R75 makes the allow-list explicit, so
// a fifth value import is a decision someone has to write down here. `./session-scope`
// joined the list in Task 8 because that module imports nothing at all (R47), which
// the check below re-states from the other side.
check("src/routes.ts value-imports exactly the dependency-free allow-list (R75)", () => {
  const ALLOWED = new Set(["./auth", "./registry-input", "./registry-store", "./session-scope"]);
  const value = importsOf(ROUTES_SOURCE)
    .filter((i) => !i.typeOnly)
    .map((i) => i.specifier.replace(/\.(?:ts|mts|js|mjs)$/, ""));
  assert.ok(value.includes("./session-scope"), "gate 2 must come from src/session-scope.ts, not a restated regex");
  for (const specifier of value) {
    assert.ok(ALLOWED.has(specifier), `value import of ${specifier} is not on the R75 allow-list`);
  }
  assert.deepEqual(new Set(value), ALLOWED, "the allow-list and routes.ts's imports drifted apart");
});

// The other half of R75: the guard is only legal because it is empty of imports. This
// file does not read src/session-scope.ts (tests/session-scope.test.mjs owns it); the
// check is here because the failure would be THIS import dying.
check("src/session-scope.ts is dependency-free, so routes.ts may value-import it (R47)", () => {
  assert.equal(
    importsOf(here("session-scope.ts")).length,
    0,
    "src/session-scope.ts imports something, so it cannot be a value import in routes.ts"
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

// Task 8's four facts about src/agent.ts that a compiler cannot see. src/agent.ts
// cannot be imported by Node, so tsc plus these text checks is the only check it gets
// (the messages RPC above is Task 7's precedent). Each one pins an ORDER or a
// LOCATION, which no type can express: a guard moved inside the `try`, an alarm armed
// per session, or a memory write that stopped being global all typecheck fine.
check("src/agent.ts's chat guard is the first statement, ahead of the try, and returns a code", () => {
  const chat = AGENT_SOURCE.match(/async\s+chat\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(chat, "src/agent.ts declares no async chat(...) to read");
  const beforeTry = chat.slice(0, chat.indexOf("try {"));
  assert.notEqual(chat.indexOf("try {"), -1, "chat no longer wraps its body in the try this guard must stay ahead of");
  assert.ok(
    /sessionScopeOk\(\s*this\.ctx,\s*\(name\)\s*=>\s*this\.idFor\(name\),\s*sessionId\s*\)/.test(
      beforeTry
    ),
    "chat must check sessionScopeOk(this.ctx, this.idFor, sessionId) ahead of the try"
  );
  assert.ok(
    /return\s+\{\s*reply:\s*"",\s*code:\s*"invalid_session"\s*\}/.test(beforeTry),
    "the refusal must RETURN the code; a throw inside the try comes back as an HTTP 200"
  );
  assert.equal(/throw/.test(stripComments(beforeTry)), false, "chat's guard throws, so the 403 would be a 200");
  // An absent id stays unscoped (the brief's Interfaces block), which is what keeps
  // src/index.ts:84 and onScheduledTask compiling until Task 22.
  assert.ok(/sessionId\s*!==\s*undefined\s*&&/.test(beforeTry), "an absent sessionId must not be refused");
});

// Fix-round 1 (reviewer findings B6 and B3): one dereference of this class's own
// namespace, one spelling of the main DO name, and no memory row written where no
// reader can ever look. All three are order/location facts a compiler cannot see, so
// they join the other src/agent.ts text checks.
check("src/agent.ts dereferences its own namespace and names main in exactly one place each", () => {
  const code = stripComments(AGENT_SOURCE);
  // Task 9's title fiber also calls REGISTRY.idFromName("registry"), which is a
  // different namespace, so the count is scoped to this agent's own namespace.
  assert.equal(
    (code.match(/this\.env\.FEDERATION_AGENT\.idFromName\(/g) ?? []).length,
    1,
    "FEDERATION_AGENT.idFromName must live only in idFor(); a second copy is how the guard and the stub drift apart"
  );
  assert.equal(
    (code.match(/this\.env\.REGISTRY\.idFromName\(/g) ?? []).length,
    1,
    "the title fiber must address the one registry instance exactly once"
  );
  assert.equal(/idFromName\("main"\)/.test(code), false, "the main DO name is imported, never spelled");
  const idFor = AGENT_SOURCE.match(/private\s+idFor\(name:\s*string\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(/this\.env\.FEDERATION_AGENT\.idFromName\(name\)/.test(idFor), "idFor must be the one dereference");
  assert.ok(
    /sessionScopeOk\(\s*this\.ctx,\s*\(name\)\s*=>\s*this\.idFor\(name\),\s*MAIN_DO_NAME\s*\)/.test(code),
    "isMainInstance must reuse idFor(), not re-derive the id"
  );
  assert.ok(/this\.env\.FEDERATION_AGENT\.get\(\s*this\.idFor\(MAIN_DO_NAME\)\s*\)/.test(code), "mainStub must reuse idFor()");
  assert.equal(/const MAIN_DO_NAME\s*=/.test(code), false, "src/agent.ts must import MAIN_DO_NAME from src/session-scope.ts");
  assert.ok(/import \{[^}]*MAIN_DO_NAME[^}]*\} from "\.\/session-scope"/.test(AGENT_SOURCE), "the import must name MAIN_DO_NAME");
  assert.ok(/import \{[^}]*MAIN_DO_NAME[^}]*\} from "\.\/session-scope"/.test(INDEX_SOURCE), "src/index.ts must take the shared name");
  assert.equal(/idFromName\("main"\)/.test(INDEX_SOURCE), false, "src/index.ts must not spell the literal");
});

check("src/agent.ts does not write a memory row to a store nothing recalls from", () => {
  const global = AGENT_SOURCE.match(/private\s+async\s+rememberGlobal\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(global, "src/agent.ts declares no rememberGlobal to read");
  const catchArm = global.slice(global.indexOf("catch"));
  assert.equal(
    /remember\(\s*this\.db\(\)/.test(catchArm),
    false,
    "a failed hop written to this DO's own store is invisible to recallGlobal (R45), so it is a row nothing can ever read"
  );
  assert.ok(/console\.error\(/.test(catchArm), "the failure belongs in the DO's logs");
});

check("src/agent.ts threads a real session id to the sandbox instead of the literal agent", () => {
  assert.equal(
    /sessionId:\s*"agent"/.test(AGENT_SOURCE),
    false,
    'a hardcoded sessionId: "agent" still names one shared sandbox session (Step 3d)'
  );
  assert.ok(
    /private\s+async\s+runSandbox\(\s*cmd:\s*string,\s*sessionId:\s*string\s*\)/.test(
      AGENT_SOURCE.replace(/\s+/g, " ")
    ),
    "runSandbox must take the sessionId rather than invent one"
  );
  // The callers: the directive path and the exec tool take the threaded id, and the
  // scheduled path passes main explicitly because after Step 3c it only runs there.
  assert.ok(/this\.runSandbox\(\s*cmd,\s*session\s*\)/.test(AGENT_SOURCE), "the directive path must pass the threaded id");
  assert.ok(/this\.runSandbox\(\s*cmd,\s*session\s*\)/.test(AGENT_SOURCE), "the exec tool must pass the threaded id");
  assert.ok(/exec:\s*\(cmd\)\s*=>\s*this\.runSandbox\(cmd,\s*session\)/.test(AGENT_SOURCE), "toolDeps must bind the session to the exec tool");
  assert.ok(/this\.chat\(\s*instructions,\s*"cheap",\s*MAIN_DO_NAME\s*\)/.test(AGENT_SOURCE), "onScheduledTask must pass main explicitly");
});

check("src/agent.ts arms the tick on main only (R46, Step 3c)", () => {
  const onStart = AGENT_SOURCE.match(/async\s+onStart\(\): Promise<void> \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(onStart, "src/agent.ts declares no async onStart() to read");
  assert.ok(/this\.db\(\);/.test(onStart), "every DO still needs its own schema, transcript included (R41)");
  assert.ok(
    /if\s*\(!this\.isMainInstance\(\)\)\s*return;[\s\S]*await\s+this\.armTick\(\);/.test(onStart),
    "onStart must return before armTick on a session DO: one alarm per DO is the platform budget"
  );
  assert.ok(
    onStart.indexOf("this.isMainInstance()") < onStart.indexOf("this.armTick()"),
    "armTick() is reachable on a session DO: the guard sits after the call"
  );
});

// Fix-round 1 (reviewer finding B1): once R46 made main the only DO that arms an
// alarm, the arm's local INSERT stored a row nothing could list or fire, while the copy
// promised an autonomous run. This pins the row to main and pins both honest refusals.
check("src/agent.ts schedules jobs where the alarm that fires them can see them (R46, fix-round 1)", () => {
  const arm = AGENT_SOURCE.match(/private\s+async\s+scheduleJob\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(arm, "src/agent.ts has no scheduleJob to read");
  assert.equal(
    /enqueueTask\(\s*sql/.test(arm),
    false,
    "the arm must not insert into the RUNNING DO's own tasks table: a session DO arms no alarm (onStart) and /api/tasks reads only main, so the row would never fire while the reply promised it would"
  );
  assert.ok(/await this\.enqueueGlobal\(/.test(arm), "the arm must hand the row to main through enqueueGlobal");
  assert.ok(/Number\.isFinite\(dueAt\)/.test(arm), "a due time the platform cannot represent must be refused BEFORE anything is stored");
  assert.equal((arm.match(/throw new Error\(/g) ?? []).length, 2, "both refusals (unrepresentable due time, failed hop) must throw so the harness records output-error");
  assert.equal((arm.match(/return\s+"/g) ?? []).length, 0, "no refusal may be returned as a string: it would settle output-available and render as a green card");

  const hop = AGENT_SOURCE.match(/private\s+async\s+enqueueGlobal\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(hop, "src/agent.ts declares no enqueueGlobal");
  assert.ok(/if\s*\(this\.isMainInstance\(\)\)/.test(hop), "main writes locally, exactly as rememberGlobal does");
  assert.ok(/Promise<boolean>/.test(hop), "the hop must report whether the row landed, or the tool lies again");
  // Fix-round 4 (reviewer D3): a window of any chars accepted an `armTick()` placed
  // after `return true`, i.e. dead code. The pin now requires the call to sit inside
  // the block BEFORE the return, so moving it past the return fails.
  assert.ok(
    /if\s*\(this\.isMainInstance\(\)\)\s*\{[^}]*await this\.armTick\(\);\s*return true;/.test(hop),
    "main's own insert must re-arm too, and before it returns, not only the taskEnqueue RPC that serves a session DO"
  );
  // Fix-round 2 (reviewer section C, the hole the first version of this pin left):
  // `this.taskEnqueue(...)` satisfied the loose `taskEnqueue(` test here and
  // recreated finding B1 exactly, because it runs on the CALLING DO's store while
  // the reply still claims the job is scheduled. The callee is the fact, so the
  // pin names the callee.
  assert.ok(
    /this\.mainStub\(\)\.taskEnqueue\(/.test(hop),
    "the hop must call taskEnqueue on MAIN's stub; this.taskEnqueue() on a session DO writes the ghost row again"
  );

  const rpc = AGENT_SOURCE.match(/\n {2}async\s+taskEnqueue\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(rpc, "src/agent.ts declares no public taskEnqueue RPC");
  assert.ok(/enqueueTask\(\s*this\.db\(\)/.test(rpc), "taskEnqueue must write the receiving DO's own store");
  assert.ok(/await this\.armTick\(\)/.test(rpc), "an insert must re-arm, or a job due in seconds waits the full 60s poll");
});

// Fix-round 2 (reviewer finding D1): every arm of a ONE-SHOT schedule inserts its own
// cf_agents_jobs row, and only the row that fires is deleted. Before the tick re-armed
// once per firing (net zero) an extra arm from onStart or from a schedule_task was
// permanent, so main ended up running onScheduledTask once per leftover row, every
// period, forever: the ghost row traded for unbounded wake amplification. This pins the
// replace-one-row idiom, its ORDER (cancel before arm), and the two copy facts the same
// round fixed (D2 the unconfirmed hop must not claim the job will not run, D3 the job
// now runs on main's transcript and sandbox lease).
check("src/agent.ts keeps exactly one alarm row for its own tick (R46, fix-round 2)", () => {
  const tick = AGENT_SOURCE.match(/private\s+async\s+armTick\(\): Promise<void> \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(tick, "src/agent.ts declares no private async armTick() to read");
  assert.ok(/await this\.listSchedules\(\)/.test(tick), "armTick must read the schedules it is about to replace");
  assert.ok(/\.callback ===\s*"onScheduledTask"/.test(tick), "it must cancel only its own callback, not the SDK's heartbeat rows");
  assert.ok(/await this\.cancelSchedule\(/.test(tick), "a cancel must actually run, or the row stays armed");
  assert.ok(
    tick.indexOf("this.cancelSchedule(") < tick.indexOf("this.schedule("),
    "arm order must be cancel-then-arm; arming first leaves the row it just cancelled's replacement behind"
  );
  // Fix-round 3 (reviewer N1): the first version of this pin tested the bare string
  // `idempotent: true`, and the WHY comment above the arm contains that string, so
  // deleting the option from the call left the suite green (mutation c, exit 0). The
  // dedup lives in the call, so the pin names the call: callback argument, then the
  // absent payload, then the options object.
  assert.ok(
    /"onScheduledTask",\s*undefined,\s*\{\s*idempotent:\s*true\s*\}/.test(tick),
    "the arm must pass idempotent:true in the schedule() call itself; without it every re-arm inserts another permanent row"
  );
  // Fix-round 4 (reviewer D2): the first argument was unpinned, so reverting the
  // 3cdcd8c unit fix to `this.schedule(wakeAt, ...)` kept the suite green even though
  // the SDK reads a numeric delay as SECONDS and every wake lands ~1000x late.
  assert.ok(
    /this\.schedule\(\s*new Date\(/.test(tick),
    "the arm must pass a Date, not a numeric delay; the SDK reads a number as seconds, which is the ~1000x-late bug"
  );
  assert.equal((tick.match(/this\.schedule\(/g) ?? []).length, 1, "one arm per tick, or the amplification returns");
  assert.equal(
    (AGENT_SOURCE.match(/this\.schedule\(/g) ?? []).length,
    1,
    "armTick is the only place this class arms the platform; a second site re-creates the duplicate-row leak"
  );

  const arm = AGENT_SOURCE.match(/private\s+async\s+scheduleJob\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(arm, "src/agent.ts has no scheduleJob to read");
  assert.ok(/unconfirmed/.test(arm), "a lost hop reply must report uncertainty, not a job that will never run");
  assert.equal(/nothing will run it/.test(arm), false, "the row may have landed; that copy is a second lie in the other direction");
  assert.match(arm, /main session's conversation/, "the job runs on main's transcript and sandbox lease, so the reply must say which chat it will appear in");
});

// R45: "simplify" here means every memory the user already accumulated goes silently
// invisible, because only main holds the store. The branch is the bug this pins out.
check("src/agent.ts keeps memory global from any DO (R45, Step 3b)", () => {
  const runTurn = AGENT_SOURCE.match(/private\s+async\s+runTurn\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(runTurn, "src/agent.ts declares no private runTurn(...) to read");
  assert.ok(
    /this\.rememberGlobal\(/.test(runTurn),
    "the turn path must write memory through rememberGlobal"
  );
  const beforeTurn = AGENT_SOURCE.match(/private\s+async\s+beforeTurn\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(beforeTurn, "src/agent.ts declares no private beforeTurn(...) to read");
  assert.ok(/this\.recallGlobal\(/.test(beforeTurn), "the model context must read memory through recallGlobal");
  const turnEnd = AGENT_SOURCE.match(/private\s+async\s+onHarnessTurnEnd\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(turnEnd, "src/agent.ts declares no private onHarnessTurnEnd(...) to read");
  assert.ok(/this\.rememberGlobal\(/.test(turnEnd), "the exchange memory must be written through rememberGlobal");
  for (const [name, body] of [["runTurn", runTurn], ["beforeTurn", beforeTurn], ["onHarnessTurnEnd", turnEnd]]) {
    assert.equal(
      /\b(?:remember|recall)\(this\.db\(/.test(body),
      false,
      `${name} writes or reads main's store through the LOCAL handle, which silently shards memory per session`
    );
  }
  const global = AGENT_SOURCE.match(/private\s+async\s+rememberGlobal\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(/if\s*\(this\.isMainInstance\(\)\)/.test(global), "rememberGlobal must branch on which DO runs");
  assert.ok(/memoryRemember\(/.test(global), "a session DO must reach main by RPC, never by its own SQLite");
  const recallPair = AGENT_SOURCE.match(/private\s+async\s+recallGlobal\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(/memoryRecall\(/.test(recallPair), "recallGlobal must RPC main for the global store");
  // The two public RPCs the hop lands on, and that they run the LOCAL store: a
  // session DO asking main must not find itself asking its own empty database.
  for (const name of ["memoryRemember", "memoryRecall"]) {
    const rpc = AGENT_SOURCE.match(new RegExp(`\\n {2}async\\s+${name}\\([\\s\\S]*?\\n {2}\\}`))?.[0] ?? "";
    assert.ok(rpc, `src/agent.ts declares no public ${name} RPC`);
    assert.ok(/this\.db\(\)/.test(rpc), `${name} must run against this DO's own store, as the pre-shard sites did`);
    assert.equal(/private/.test(rpc), false, `${name} is what a session DO calls over a stub, so it cannot be private`);
  }
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
  const res = await handleFetch(req("/api/sessions/abc/messages"), world.env, world.ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(world.fed.names, ["abc"]);
  assert.equal(world.fed.addressed.includes("main"), false, "R41: no silent fallback to main");
  // Gate 3 covers `messages` as well as `chat` (Step 3a): the transcript read is the
  // other half of the orphan-DO exposure amendment 4 describes.
  assert.deepEqual(world.registry.calls, [["exists", "abc"]], "the read is preceded by one existence read");
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

// The id travels twice (Task 8): once as the DO this addresses, and once as `chat`'s
// third argument, which is the only way the DO can check the claim. Drop the third
// argument and src/agent.ts's guard becomes dead code and the 403 unreachable.
await checkAsync("the send calls chat(content, tier, sessionId) with three arguments (R65, Task 8)", async () => {
  const world = setup();
  await handleFetch(
    req("/api/sessions/abc/message", "POST", {
      body: JSON.stringify({ content: "say pong", tier: "cheap" }),
    }),
    world.env,
    world.ctx
  );
  const call = world.fed.chats[0];
  assert.equal(call.arity, 3, "chat grows exactly the session id, in last position");
  assert.deepEqual(call.args, ["say pong", "cheap", "abc"]);
  assert.equal(call.args[2], "abc", "the id handed to chat is the id the route addressed");
});

await checkAsync("an absent or unknown tier is passed through as undefined, still three arguments", async () => {
  const world = setup();
  await handleFetch(
    req("/api/sessions/abc/message", "POST", { body: JSON.stringify({ content: "hello" }) }),
    world.env,
    world.ctx
  );
  assert.equal(world.fed.chats[0].arity, 3);
  assert.deepEqual(world.fed.chats[0].args, ["hello", undefined, "abc"]);
  assert.equal(world.fed.chats[0].args[1], undefined, "no tier means undefined, the same rule as src/index.ts:82");
});

// R74: this sequence is the gate order made visible, exists then touch, and R73's
// amendment 5 is the reason the touch still lands in the recorder: the fake pushes
// before its first `await`, so the call happens even though the route now hands the
// promise to `ctx.waitUntil` instead of awaiting it.
await checkAsync("a successful send touches the registry once with (id, undefined)", async () => {
  const world = setup();
  const res = await handleFetch(
    req("/api/sessions/abc/message", "POST", { body: JSON.stringify({ content: "hello" }) }),
    world.env,
    world.ctx
  );
  assert.equal(res.status, 200);
  assert.deepEqual(
    world.registry.calls,
    [["exists", "abc"], ["touch", "abc", undefined]],
    "gate 3 reads the index, then the accepted reply touches it, and nothing else"
  );
  assert.deepEqual(
    world.registry.touchCalls,
    [["abc", undefined]],
    "touch(id) with NO opts: bumps updated_at only, and unread is a later phase"
  );
  await Promise.all(world.promised);
  assert.equal(world.promised.length, 1, "the touch went through ctx.waitUntil, exactly once (amendment 5)");
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

// Gate 3 runs BEFORE the body is parsed (R76), so the existence read happens even on
// a request that 400s afterwards. This is the assertion that distinguishes the two
// orders: with the body parsed first, a bad body on an uncreated id would answer 400
// and leak nothing, and the leak would only show on a well-formed body.
await checkAsync("touch never runs when the body is malformed", async () => {
  for (const body of ["{oops", "{}", '{"content":""}', '{"content":5}', "null"]) {
    const world = setup();
    const res = await handleFetch(
      req("/api/sessions/abc/message", "POST", { body }),
      world.env,
      world.ctx
    );
    assert.equal(res.status, 400, `body ${body} must be a 400`);
    assert.deepEqual(world.registry.calls, [["exists", "abc"]], `body ${body} must not touch`);
    assert.deepEqual(world.registry.touchCalls, [], `body ${body} must not bump updated_at`);
    assert.deepEqual(world.promised, [], `body ${body} must schedule nothing`);
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
  assert.equal(
    world.fed.chats[0].args[2],
    "main",
    "main is the session id the legacy DO owns, so the DO's own guard accepts it"
  );
});

// -------------------------------------------- GET /api/sessions/:id/stream/:id ----

// Task 22: EventSource cannot set an Authorization header, so this ONE shape may
// authenticate with ?token=. The route forwards to the DO that owns the Streams
// instance, because sseResponse must run where the chunks were written.
const STREAM_SEGMENT = encodeURIComponent("s:abc:op1");

await checkAsync("GET stream accepts ?token= and proxies to the session DO", async () => {
  const world = setup();
  const res = await handleFetch(
    req(`/api/sessions/abc/stream/${STREAM_SEGMENT}?token=k&from=7`, "GET", { headers: {} }),
    world.env,
    world.ctx
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.deepEqual(world.registry.calls, [["exists", "abc"]], "the row is checked before the DO is addressed");
  assert.deepEqual(world.fed.names, ["abc"], "the owning session's DO is the only one addressed");
  assert.equal(world.fed.fetches.length, 1);
  const forwarded = world.fed.fetches[0];
  const target = new URL(forwarded.request.url);
  assert.equal(target.pathname, `/internal/stream/${STREAM_SEGMENT}`);
  assert.equal(target.searchParams.get("token"), null, "the shared key never crosses the internal hop");
  assert.equal(target.searchParams.get("from"), "7", "from survives, so sseResponse can resume");
  assert.equal(forwarded.request.headers.get("authorization"), null, "the internal hop carries no auth header");
});

await checkAsync("GET stream keeps Last-Event-ID on the internal hop", async () => {
  const world = setup();
  const res = await handleFetch(
    req(`/api/sessions/abc/stream/${STREAM_SEGMENT}`, "GET", {
      headers: { ...AUTH, "last-event-id": "5" },
    }),
    world.env,
    world.ctx
  );
  assert.equal(res.status, 200, "the bearer header alone is still accepted");
  const forwarded = world.fed.fetches[0].request;
  assert.equal(forwarded.headers.get("last-event-id"), "5", "a reconnect resumes from its cursor");
});

await checkAsync("a stream id that does not name the session is 404 before any DO", async () => {
  for (const raw of [encodeURIComponent("s:def:op1"), "op1", "s%3Aabc"]) {
    const world = setup();
    const res = await handleFetch(
      req(`/api/sessions/abc/stream/${raw}`, "GET"),
      world.env,
      world.ctx
    );
    assert.equal(res.status, 404, `${raw} must not name another session's stream`);
    assert.deepEqual(world.registry.calls, [], `${raw} must not reach the registry`);
    assert.deepEqual(world.fed.names, [], `${raw} must not address a DO`);
    assert.equal(world.fed.fetches.length, 0, `${raw} must not reach a DO fetch`);
  }
});

await checkAsync("GET stream for an absent session is 404 and never addresses a DO", async () => {
  const world = setup({ rows: [] });
  const res = await handleFetch(
    req(`/api/sessions/abc/stream/${STREAM_SEGMENT}`, "GET"),
    world.env,
    world.ctx
  );
  assert.equal(res.status, 404);
  assert.deepEqual(world.registry.calls, [["exists", "abc"]]);
  assert.deepEqual(world.fed.names, []);
  assert.equal(world.fed.fetches.length, 0);
});

await checkAsync("a wrong query token is 401 and reaches nothing", async () => {
  const world = setup();
  const res = await handleFetch(
    req(`/api/sessions/abc/stream/${STREAM_SEGMENT}?token=wrong`, "GET", { headers: {} }),
    world.env,
    world.ctx
  );
  assert.equal(res.status, 401);
  assert.deepEqual(world.registry.calls, []);
  assert.deepEqual(world.fed.names, []);
  assert.equal(world.fed.fetches.length, 0);
});

await checkAsync("?token= authenticates only the GET stream shape", async () => {
  for (const [path, method, body] of [
    ["/api/sessions/abc/message?token=k", "POST", JSON.stringify({ content: "hi" })],
    ["/api/sessions/abc/messages?token=k", "GET", undefined],
    ["/api/sessions?token=k", "GET", undefined],
    ["/api/sessions/abc?token=k", "DELETE", undefined],
  ]) {
    const world = setup();
    const res = await handleFetch(
      req(path, method, body === undefined ? { headers: {} } : { headers: {}, body }),
      world.env,
      world.ctx
    );
    assert.equal(res.status, 401, `${method} ${path}: the query token is not a general credential`);
    assert.deepEqual(world.registry.calls, []);
    assert.equal(world.fed.fetches.length, 0);
  }
});

// --------------------------------------------- Task 8: gates, refusal, shapes ----

// Step 3a: the DO's refusal is a `code` on the reply, and R76 turns it into a 403.
// Amendment 2 is the half a status code cannot show: a refused request is not
// activity, so the registry must not hear about it at all, not even via waitUntil.
await checkAsync("a reply carrying code invalid_session is 403 and skips the touch (R71 amendment 2)", async () => {
  const world = setup();
  world.fed.reply = { reply: "", code: "invalid_session" };
  const res = await handleFetch(
    req("/api/sessions/abc/message", "POST", { body: JSON.stringify({ content: "hello" }) }),
    world.env,
    world.ctx
  );
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { ok: false, error: "invalid session" });
  assert.deepEqual(world.registry.calls, [["exists", "abc"]], "the refusal must not touch the registry");
  assert.deepEqual(world.registry.touchCalls, []);
  assert.deepEqual(world.promised, [], "the 403 branch schedules nothing");
});

// The 403 is a DIFFERENT code from the codes that already mean something, so a reply
// carrying any other code is still an answer the person gets (Task 7's pin above).
await checkAsync("only code invalid_session refuses; another code is still a 200 answer", async () => {
  for (const code of ["pending", "still_a_reply", ""]) {
    const world = setup();
    world.fed.reply = { reply: "an answer", code };
    const res = await handleFetch(
      req("/api/sessions/abc/message", "POST", { body: JSON.stringify({ content: "hello" }) }),
      world.env,
      world.ctx
    );
    assert.equal(res.status, 200, `code ${JSON.stringify(code)} is not a refusal`);
    assert.deepEqual(world.registry.touchCalls, [["abc", undefined]]);
  }
});

// Amendment 4 (R73): `idFromName` cannot report absence, so gate 3 is the only thing
// standing between any 26-hex name and a DO instance nobody can list again. PATCH is in
// this loop because gate 3 guards it for a different reason: rename is a whole-row
// UPDATE, so an absent id would otherwise answer { ok: true } for nothing.
await checkAsync("a well-formed id with no registry row is 404 and never addresses a DO (amendment 4)", async () => {
  const GHOST = "0123456789abcdef0123456789abcdef";
  for (const [path, method, body] of [
    [`/api/sessions/${GHOST}/message`, "POST", JSON.stringify({ content: "hello" })],
    [`/api/sessions/${GHOST}/messages`, "GET", undefined],
    [`/api/sessions/${GHOST}`, "PATCH", JSON.stringify({ title: "renamed" })],
  ]) {
    const world = setup();
    const res = await handleFetch(
      req(path, method, body === undefined ? {} : { body }),
      world.env,
      world.ctx
    );
    assert.equal(res.status, 404, `${method} ${path}: an absent row is 404`);
    assert.deepEqual(await res.json(), { ok: false, error: "not found" });
    assert.deepEqual(world.registry.calls, [["exists", GHOST]], "the existence read is the only registry call");
    assert.deepEqual(world.fed.names, [], "gate 3 runs before idFromName, so no DO is instantiated");
    assert.equal(world.fed.chats.length, 0, `${method} ${path}: an uncreated session must not run the agent`);
    assert.equal(world.fed.messageCalls.length, 0, `${method} ${path}: an uncreated session must not read a transcript`);
    assert.deepEqual(world.registry.touchCalls, []);
    assert.deepEqual(world.promised, []);
  }
});

// Step 3a's real job: the string stops here, before `idFromName` ever sees it. These
// are the shapes that SURVIVE URL path normalization and only turn hostile when
// `idFromSegment` decodes them, which is why the check has to run on the decoded
// value. A whole `%2e%2e` segment is NOT one of them; see the case below.
await checkAsync("a decoded-hostile :id is 400 before any idFromName call (R76 gate 2)", async () => {
  const HOSTILE = [
    ["abc%2fdef", "abc/def", "an encoded slash would name a path"],
    ["a%20b", "a b", "an encoded space is not an id"],
    ["abc%2e%2edef", "abc..def", "dots survive only inside a longer segment"],
    ["..%2f..%2fetc", "../../etc", "an encoded traversal survives the URL layer"],
    ["%252e%252e", "%2e%2e", "a double-encoded dot decodes to a literal %2e%2e"],
    ["s%3Amain", "s:main", "the deleted prefixed form cannot sneak through (R38)"],
    ["x".repeat(41), "a 41-char id", "the 40-char ceiling is the guard's, not a DO limit"],
  ];
  for (const [segment, decoded, why] of HOSTILE) {
    for (const [suffix, method] of [["/message", "POST"], ["/messages", "GET"], ["", "PATCH"]]) {
      const world = setup();
      const res = await handleFetch(
        req(`/api/sessions/${segment}${suffix}`, method, method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
        world.env,
        world.ctx
      );
      assert.equal(res.status, 400, `${method} ${segment}: ${why}`);
      assert.deepEqual(await res.json(), { ok: false, error: "invalid session id" });
      assert.deepEqual(world.fed.names, [], `${segment} (${decoded}) must never reach idFromName`);
      assert.deepEqual(world.registry.calls, [], `${segment} must not reach the registry either`);
    }
  }
});

// Amendment 1 (R71), as it actually measures. A `%2e%2e` SEGMENT is normalized by the
// URL parser exactly like a literal `..` (both are "double-dot path segments", and
// the encoding is decoded for that comparison), so `/api/sessions/%2e%2e/message`
// reaches this module as `/api/message`: outside the prefix, so this module's fall-
// through answers 404 and the guard never runs, which is why the case can never be a
// 400. What the WORKER then does with it is src/index.ts's business, and it is not a
// refusal: `/api/message` is a live route, authed and pinned to main. `/api/etc/
// message` is the one that truly 404s. The encoded form therefore proves nothing about
// the guard, and both spellings are the same fact.
await checkAsync("a path that normalises out of the prefix is a 404, not a 400 (amendment 1)", async () => {
  for (const path of [
    "/api/sessions/../etc/message",
    "/api/sessions/%2e%2e/message",
    "/api/sessions/%2E%2E/message",
    "/api/sessions/%2e%2e/messages",
    "/api/sessions/%2e%2e",
  ]) {
    const before = new URL(path, "https://blip.test").pathname;
    assert.equal(
      before.startsWith("/api/sessions"),
      false,
      `${path} normalises to ${before}, which is the whole point of this case`
    );
    const world = setup();
    const res = await handleFetch(req(path, "POST", { body: JSON.stringify({ content: "hi" }) }), world.env, world.ctx);
    assert.equal(res.status, 404, `${path} -> ${before} is the fall-through, not the guard`);
    assert.deepEqual(world.fed.names, [], `${path} must not address a DO`);
    assert.deepEqual(world.registry.calls, []);
  }
});

// The order is the contract (R76), so the three refusals are run against the SAME
// request body, each one allowed to answer only if the gate above it accepted.
await checkAsync("the gates run in order: auth, then shape, then existence, then the DO (R76)", async () => {
  const BAD_BODY = "{ not json";
  // 1. No key: nothing else runs, not even the shape check that would 400.
  const unauth = setup({ key: "" });
  assert.equal(
    (await handleFetch(req("/api/sessions/%2e%2e/message", "POST", { body: BAD_BODY }), unauth.env, unauth.ctx)).status,
    404,
    "the encoded traversal leaves the prefix before even the auth gate"
  );
  const badShape = setup();
  assert.equal(
    (await handleFetch(
      req("/api/sessions/a%20b/message", "POST", { body: BAD_BODY }),
      badShape.env,
      badShape.ctx
    )).status,
    400,
    "gate 2 answers before the body is parsed"
  );
  assert.deepEqual(badShape.fed.names, [], "a bad shape never resolves a DO id");
  // 3. A good shape, a bad body and NO row: the row check wins, so the answer is 404.
  const absent = setup({ rows: [] });
  const absentRes = await handleFetch(
    req("/api/sessions/abc/message", "POST", { body: BAD_BODY }),
    absent.env,
    absent.ctx
  );
  assert.equal(absentRes.status, 404, "gate 3 runs before the body parse, so an absent row answers 404");
  assert.deepEqual(absent.fed.names, [], "an absent row never addresses a DO");
  // 4. Good shape, real row, bad body: only now does the 400 get its turn.
  const present = setup();
  assert.equal(
    (await handleFetch(req("/api/sessions/abc/message", "POST", { body: BAD_BODY }), present.env, present.ctx)).status,
    400,
    "gate 4 is where the body is finally read"
  );
  assert.deepEqual(present.registry.calls, [["exists", "abc"]]);
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
    [`/api/sessions/abc/stream/${STREAM_SEGMENT}?token=k`, "GET", undefined],
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

// The seven routes the Interfaces block enumerates are the whole family: a shape, or
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
    assert.equal(res.status, 404, `${method} ${path} is not one of the seven routes`);
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
