// Contract tests for Task 6: the registry Durable Object and the two shapes it
// exports from src/types.ts.
//
// Plain Node, no framework, no build step: run with `node tests/types.test.mjs`.
//
// Why this file reads some sources as TEXT. Node cannot import src/registry.ts:
// it value-imports `agents`, which pulls in `cloudflare:workers` (the plan's D6
// limit, restated in progress.md R47). src/types.ts is interfaces plus two
// consts, so a text assertion is the only offline surface it has. That is not a
// weaker proof for the parts that matter: the two SQL statements this task owns
// are lifted out of src/registry.ts by name and EXECUTED against a real sqlite
// database below, which a text match alone cannot fake.
//
// Scope note: the config check reads repo-clone/wrangler.jsonc only. The deploy
// tree is a separate checkout holding real secrets and is never opened here
// (R56), so `RegistryAgent` is proven structurally: v1 untouched, the class in
// a NEW migration tag (R57). The owner runs the real dry-run before deploying.
//
// Silent on success (exit 0). Prints every failure and exits 1 otherwise.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  PLACEHOLDER_TITLE,
  ensureRegistrySchema,
  getSession,
  listSessions,
  renameSession,
  upsertSession,
} from "../src/registry-store.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const typesSrc = read("src/types.ts");
const indexSrc = read("src/index.ts");
const registrySrc = read("src/registry.ts");
const wranglerSrc = read("wrangler.jsonc");

// R55, verbatim: the boot seed is a DIRECT statement, never upsertSession,
// because a whole-row replace at boot would reset a title a user renamed.
const MAIN_SEED_EXPECTED =
  "INSERT INTO sessions (id, title, created_at, updated_at, pinned, unread) VALUES (?, ?, ?, ?, 0, 0) ON CONFLICT(id) DO NOTHING";

const AGENT_STUB_METHODS = [
  "chat",
  "jobList",
  "planState",
  "approveAction",
  "vaultPut",
  "vaultPull",
  "vaultChunk",
  "vaultHealth",
  "vaultDelete",
];

// The sidebar's only order, as src/registry-store.ts emits it.
const SIDEBAR_SQL = `SELECT id, title, created_at, updated_at, workspace_ref, unread, pinned
 FROM sessions ORDER BY pinned DESC, updated_at DESC LIMIT ?`;

const failures = [];

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

// Whitespace-normalized so one line in a test reads the same as a wrapped one in src/.
const flat = (query) => query.replace(/\s+/g, " ").trim();

/** The string literal assigned to a module-level const. */
function constString(src, name, where) {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*"([^"]*)"`));
  assert.ok(m, `${where} declares no string const named ${name}`);
  return m[1];
}

/** Body of an exported interface, or a missing-export failure. */
function interfaceBody(src, name) {
  const m = src.match(new RegExp(`export interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `src/types.ts does not export interface ${name}`);
  return m[1];
}

function methodNames(body) {
  return [...body.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]);
}

/** Placeholder-checked exec over a real in-memory database, as src/agent.ts's db() does. */
function realHandle(db) {
  return {
    exec(query, ...bindings) {
      const parts = query.split("?");
      if (parts.length !== bindings.length + 1) {
        throw new Error(`placeholder mismatch: ${parts.length - 1} vs ${bindings.length}`);
      }
      return { results: db.prepare(parts.join("?")).all(...bindings) };
    },
  };
}

// ---- src/types.ts: the shapes a dependency-free src/routes.ts may consume (R39) ----

check("src/types.ts exports AgentStub and src/index.ts no longer declares its own copy", () => {
  assert.match(typesSrc, /^export interface AgentStub\b/m, "AgentStub is not exported from types.ts");
  assert.equal(
    /interface AgentStub\b/.test(indexSrc),
    false,
    "src/index.ts still declares AgentStub, so the shape exists twice"
  );
  assert.match(
    indexSrc,
    /import type \{[^}]*\bAgentStub\b[^}]*\} from "\.\/types"/,
    "src/index.ts does not import AgentStub from ./types"
  );
});

check("AgentStub carries the nine FederationAgent RPC methods the worker calls", () => {
  assert.deepEqual(methodNames(interfaceBody(typesSrc, "AgentStub")), AGENT_STUB_METHODS);
});

check("src/types.ts stays import-type-only so a text-level consumer cannot pull runtime", () => {
  for (const line of typesSrc.split(/\r?\n/)) {
    if (!/^\s*import\b/.test(line)) continue;
    assert.match(line, /^\s*import type\b/, `value import in src/types.ts: ${line}`);
  }
});

check("RegistryStub mirrors RegistryAgent's five RPC methods exactly", () => {
  assert.deepEqual(
    methodNames(interfaceBody(typesSrc, "RegistryStub")),
    ["list", "put", "rename", "remove", "touch"]
  );
});

check("RegistryStub's write methods return Promise<void>, never a boolean (R37, R58)", () => {
  const body = interfaceBody(typesSrc, "RegistryStub");
  assert.equal(/boolean/.test(body), false, `a boolean survives in RegistryStub: ${body}`);
  for (const name of ["put", "rename", "remove", "touch"]) {
    assert.match(
      body,
      new RegExp(`\\b${name}\\([^)]*\\): Promise<void>;`),
      `${name} does not return Promise<void}: ${body}`
    );
  }
  assert.match(body, /\blist\(limit: number\): Promise<SessionRow\[\]>;/, body);
  assert.match(body, /\bput\(row: SessionRow\): Promise<void>;/, body);
  assert.match(body, /\brename\(id: string, title: string\): Promise<void>;/, body);
  assert.match(body, /\bremove\(id: string\): Promise<void>;/, body);
  assert.match(body, /\btouch\(id: string, opts\?: \{ unreadDelta\?: number \}\): Promise<void>;/, body);
});

check("SessionRow reaches RegistryStub as a type import, not a value import", () => {
  assert.match(typesSrc, /import type \{[^}]*\bSessionRow\b[^}]*\} from "\.\/registry-store"/);
});

check("Env gains the REGISTRY DurableObjectNamespace binding", () => {
  assert.match(typesSrc, /\bREGISTRY: DurableObjectNamespace;/, "Env has no REGISTRY binding");
});

// ---- src/registry.ts: read as text, executed below ----

check("RegistryAgent is the class the wrangler binding names and the entry module exports it", () => {
  assert.match(registrySrc, /export class RegistryAgent extends Agent<Env>/);
  assert.match(
    indexSrc,
    /export \{[^}]*\bRegistryAgent\b[^}]*\}/,
    "wrangler discovers DO classes from the entry module's exports; src/index.ts does not export RegistryAgent"
  );
});

check("the five RPC methods exist on the class with the ruled signatures", () => {
  for (const pattern of [
    /async list\(limit: number\): Promise<SessionRow\[\]>/,
    /async put\(row: SessionRow\): Promise<void>/,
    /async rename\(id: string, title: string\): Promise<void>/,
    /async remove\(id: string\): Promise<void>/,
    /async touch\(id: string, opts\?: \{ unreadDelta\?: number \}\): Promise<void>/,
  ]) {
    assert.match(registrySrc, pattern);
  }
});

check("fetch falls through to super.fetch for anything the registry does not own", () => {
  assert.match(registrySrc, /async fetch\(request: Request\): Promise<Response>/);
  assert.match(registrySrc, /startsWith\("\/registry\/"\)/, "no /registry/ ownership guard");
  assert.match(
    registrySrc,
    /return super\.fetch\(request\);/,
    "fetch() must not hard-stop: overriding it replaces the SDK entry point"
  );
});

check("the boot seed is R55's statement, verbatim", () => {
  assert.equal(
    flat(constString(registrySrc, "MAIN_SEED_STATEMENT", "src/registry.ts")),
    flat(MAIN_SEED_EXPECTED)
  );
});

check("upsertSession is called exactly once, by put, so the seed cannot be a whole-row replace", () => {
  const calls = (registrySrc.match(/upsertSession\(/g) || []).length;
  assert.equal(calls, 1, `upsertSession( appears ${calls} times; only put may call it`);
});

check("nothing in the registry reads or returns an affected-row count (R58)", () => {
  assert.equal(
    /\.\s*meta\b|\.\s*changes\b|SELECT changes\(\)/i.test(registrySrc),
    false,
    "an affected-row read exists in src/registry.ts"
  );
});

check("no SQL in the registry interpolates a value into its own statement text", () => {
  for (const line of registrySrc.split(/\r?\n/)) {
    if (!/INSERT INTO|UPDATE |SELECT |DELETE FROM|CREATE /.test(line)) continue;
    assert.equal(
      line.includes("${"),
      false,
      `interpolated value in a SQL line: ${line.trim()}`
    );
  }
});

check("onStart runs the schema, the index, then the seed, in that order", () => {
  const m = registrySrc.match(/async onStart\(\): Promise<void> \{([\s\S]*?)\n {2}\}/);
  assert.ok(m, "no async onStart(): Promise<void> block found");
  const body = m[1];
  const at = (needle) => body.indexOf(needle);
  assert.ok(at("ensureRegistrySchema") >= 0, "onStart does not run ensureRegistrySchema");
  assert.ok(at("PINNED_ORDER_INDEX_STATEMENT") > at("ensureRegistrySchema"), "index not created after the schema");
  assert.ok(at("MAIN_SEED_STATEMENT") > at("PINNED_ORDER_INDEX_STATEMENT"), "seed not run after the index");
});

// ---- real execution ----

check("seeding main twice keeps a title a user renamed", () => {
  const db = new DatabaseSync(":memory:");
  const sql = realHandle(db);
  const seed = constString(registrySrc, "MAIN_SEED_STATEMENT", "src/registry.ts");
  ensureRegistrySchema(sql);
  sql.exec(seed, "main", PLACEHOLDER_TITLE, 1000, 1000);
  assert.equal(getSession(sql, "main").title, PLACEHOLDER_TITLE);
  renameSession(sql, "main", "my real thread");
  sql.exec(seed, "main", PLACEHOLDER_TITLE, 2000, 2000);
  const row = getSession(sql, "main");
  assert.equal(row.title, "my real thread", "the boot seed overwrote a renamed title");
  assert.equal(row.created_at, 1000, "the second seed disturbed created_at");
  assert.equal(listSessions(sql, 50).length, 1, "the seed inserted a second row");
  db.close();
});

check("the composite index matches the sidebar ORDER BY and removes the temp b-tree (R59)", () => {
  const db = new DatabaseSync(":memory:");
  const sql = realHandle(db);
  const indexStmt = constString(registrySrc, "PINNED_ORDER_INDEX_STATEMENT", "src/registry.ts");
  ensureRegistrySchema(sql);
  sql.exec(indexStmt);
  for (let i = 0; i < 200; i++) {
    upsertSession(sql, {
      id: `id${i}`,
      title: `t${i}`,
      created_at: i,
      updated_at: (i * 7919) % 100000,
      workspace_ref: null,
      unread: i % 3,
      pinned: i % 5 === 0 ? 1 : 0,
    });
  }
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${SIDEBAR_SQL}`).all(50).map((row) => row.detail).join(" | ");
  assert.equal(/USE TEMP B-TREE/.test(plan), false, `the sidebar still sorts: ${plan}`);
  assert.match(plan, /sessions_pinned_updated/, `the composite index is not used: ${plan}`);
  const listed = listSessions(sql, 50);
  assert.equal(listed.length, 50);
  for (let i = 1; i < listed.length; i++) {
    const a = listed[i - 1];
    const b = listed[i];
    assert.ok(
      a.pinned > b.pinned || (a.pinned === b.pinned && a.updated_at >= b.updated_at),
      `list order broken at ${i}: ${a.id}/${a.pinned}/${a.updated_at} before ${b.id}/${b.pinned}/${b.updated_at}`
    );
  }
  db.close();
});

check("the composite index is idempotent, so a repeated onStart cannot fail", () => {
  const db = new DatabaseSync(":memory:");
  const sql = realHandle(db);
  const indexStmt = constString(registrySrc, "PINNED_ORDER_INDEX_STATEMENT", "src/registry.ts");
  ensureRegistrySchema(sql);
  sql.exec(indexStmt);
  sql.exec(indexStmt);
  db.close();
});

// ---- repo-clone/wrangler.jsonc only (R56, R57) ----

/** Comment-only lines dropped, trailing commas closed, then real JSON.parse. */
function parseJsonc(text) {
  const noComments = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(noComments);
}

check("wrangler binds REGISTRY to RegistryAgent and adds it to a NEW migration tag", () => {
  // Parses as well as matches text, so a stray comma cannot hide until deploy.
  const cfg = parseJsonc(wranglerSrc);
  const bindings = cfg.durable_objects.bindings;
  assert.deepEqual(
    bindings.find((b) => b.name === "REGISTRY"),
    { name: "REGISTRY", class_name: "RegistryAgent" },
    `no REGISTRY binding in durable_objects.bindings: ${JSON.stringify(bindings.map((b) => b.name))}`
  );
  assert.deepEqual(
    bindings.find((b) => b.name === "FEDERATION_AGENT"),
    { name: "FEDERATION_AGENT", class_name: "FederationAgent" },
    "the live FEDERATION_AGENT binding changed shape"
  );
  const byTag = Object.fromEntries(cfg.migrations.map((m) => [m.tag, m.new_sqlite_classes]));
  assert.deepEqual(byTag["v1"], ["FederationAgent"], "the applied v1 migration changed");
  const owners = cfg.migrations
    .filter((m) => (m.new_sqlite_classes || []).includes("RegistryAgent"))
    .map((m) => m.tag);
  assert.equal(owners.length, 1, `RegistryAgent appears in ${owners.length} migration(s): ${owners.join(", ")}`);
  assert.ok(owners[0], "RegistryAgent is in no migration at all");
  assert.notEqual(owners[0], "v1", "RegistryAgent was appended to the applied v1 migration");
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`types: ${failures.length} failed`);
  process.exit(1);
}
