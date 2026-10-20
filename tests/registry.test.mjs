// Contract tests for Task 6: the registry Durable Object's two rulings that a
// compiler cannot see, plus the wrangler shape that only a text read can prove.
//
// Plain Node, no framework, no build step: run with `node tests/registry.test.mjs`.
//
// Why this file reads some sources as TEXT. Node cannot import src/registry.ts:
// it value-imports `agents`, which pulls in `cloudflare:workers` (the plan's D6
// limit, restated in progress.md R47). That is the only reason anything here is
// matched as text, and the two things that matter are EXECUTED against a real
// sqlite database, which a text match alone cannot fake.
//
// What is deliberately NOT here. src/types.ts is interfaces plus two consts, so
// `tsc --noEmit` already enforces every signature in it; the signature mirrors
// this file used to carry (the AgentStub and RegistryStub method lists, the
// Promise<void> regexes) are gone per R64 I4, because a regex that restates a
// parameter list adds a second place to be wrong and no rule of its own. The
// DO's input parsing is not here either: it moved to src/registry-input.ts and is
// executed by tests/registry-input.test.mjs, and the SQL adapter moved to
// src/sql-handle.ts and is executed by tests/sql-handle.test.mjs.
//
// Scope note: the config check reads repo-clone/wrangler.jsonc only. The deploy
// tree is a separate checkout holding real secrets and is never opened here
// (R56), so `RegistryAgent` is proven structurally: v1 untouched, the class in a
// NEW migration tag (R57). The owner runs the real dry-run before deploying.
// Nothing printed from that file is a value: binding NAMES only.
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

/** Placeholder-checked exec over a real in-memory database, as src/sql-handle.ts does. */
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

const indexNames = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
    .all()
    .map((row) => row.name);

// ---- rules the compiler cannot see, in src/types.ts and src/index.ts ----

check("src/index.ts no longer declares AgentStub and imports it from ./types", () => {
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

check("src/types.ts stays import-type-only so a text-level consumer cannot pull runtime", () => {
  for (const line of typesSrc.split(/\r?\n/)) {
    if (!/^\s*import\b/.test(line)) continue;
    assert.match(line, /^\s*import type\b/, `value import in src/types.ts: ${line}`);
  }
});

check("wrangler discovers RegistryAgent from the entry module's exports", () => {
  assert.match(registrySrc, /export class RegistryAgent extends Agent<Env>/);
  assert.match(
    indexSrc,
    /export \{[^}]*\bRegistryAgent\b[^}]*\}/,
    "wrangler discovers DO classes from the entry module's exports; src/index.ts does not export RegistryAgent"
  );
});

check("nothing in the registry reads or returns an affected-row count (R58)", () => {
  assert.equal(
    /\.\s*meta\b|\.\s*changes\b|SELECT changes\(\)/i.test(registrySrc),
    false,
    "an affected-row read exists in src/registry.ts"
  );
});

check("the DO runs no DDL of its own, so the store is the only schema owner (R54, R64)", () => {
  assert.equal(
    /CREATE (TABLE|INDEX)/.test(registrySrc),
    false,
    "src/registry.ts still creates schema, so the store and the DO can disagree"
  );
  assert.equal(
    /ensureRegistrySchema/.test(registrySrc.match(/async onStart\(\): Promise<void> \{[\s\S]*?\n {2}\}/)?.[0] ?? ""),
    false,
    "onStart() creates the schema a second time instead of going through this.db()"
  );
});

// ---- real execution ----

check("the R55 boot seed keeps a title a user renamed and inserts no second row", () => {
  const db = new DatabaseSync(":memory:");
  const sql = realHandle(db);
  const seed = constString(registrySrc, "MAIN_SEED_STATEMENT", "src/registry.ts");
  assert.equal(flat(seed), flat(MAIN_SEED_EXPECTED), "the seed is no longer R55's direct statement");
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

check("the composite index matches the sidebar ORDER BY and removes the temp b-tree (R54)", () => {
  const db = new DatabaseSync(":memory:");
  const sql = realHandle(db);
  // No index statement is run here: ensureRegistrySchema owns it, which is the
  // ruling, and this is what proves the lazy db() guard really does create it.
  ensureRegistrySchema(sql);
  assert.ok(indexNames(db).includes("sessions_pinned_updated"), `no composite index: ${indexNames(db)}`);
  assert.equal(
    indexNames(db).includes("sessions_updated_at"),
    false,
    "the single-column index nothing queries is still being created"
  );
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
  console.error(`registry: ${failures.length} failed`);
  process.exit(1);
}
