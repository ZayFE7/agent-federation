// Contract tests for src/session-scope.ts: the one copy of the session-id rule
// (R38) and the DO's own check that a session belongs to it (plan Task 8).
//
// Why this file can be so small. Every function here is pure over its arguments:
// the DO state and the namespace are read only through `id.toString()` and
// `idFromName(name).toString()`, so a plain object with a toString is a complete
// fixture and no platform type is needed. That is deliberate (R47): this module
// must import NOTHING at all, so it stays value-importable from src/routes.ts,
// which is the only part of the worker an offline Node test can reach (R39). The
// last check below pins exactly that, by reading this module's own source.
//
// Plain Node, no framework, no build step: run with `node tests/session-scope.test.mjs`.
// Silent on success (exit 0). Prints every failure and exits 1 otherwise.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAIN_DO_NAME,
  SESSION_ID_RE,
  ScopeError,
  assertSessionScope,
  isSessionId,
  sessionScopeOk,
} from "../src/session-scope.ts";

const failures = [];

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

// ----------------------------------------------------------------- fixtures ----

/** A DO addressed as `name`, shaped like DurableObjectState only where the guard reads it. */
const ctxFor = (name) => ({ id: { toString: () => `do:${name}` } });

/** A namespace that resolves a name the way the platform does: deterministically, per name. */
const idFromName = (name) => ({ toString: () => `do:${name}` });

// Every case the guard answers, and what it must answer. The hostile ids sit in
// pairs with the name that would make a bare string compare succeed, so a check
// that only compared ids (and never looked at the shape) cannot pass this table:
// a client must not be able to steer which DO id it names, and no prefixed id can
// sneak through (R38 deletes the "s:" prefix for good).
const CASES = [
  { name: "the id this DO was created from", doName: "abc", sessionId: "abc", ok: true },
  { name: "legacy main is a session like any other", doName: "main", sessionId: "main", ok: true },
  { name: "a session id aimed at another DO", doName: "main", sessionId: "abc", ok: false },
  { name: "another DO's id aimed at this one", doName: "abc", sessionId: "main", ok: false },
  { name: "the empty id", doName: "abc", sessionId: "", ok: false },
  { name: "an id with a slash", doName: "abc/def", sessionId: "abc/def", ok: false },
  { name: "an id of dot-dot", doName: "..", sessionId: "..", ok: false },
  { name: "an id with a space", doName: "a b", sessionId: "a b", ok: false },
  { name: "a prefixed id", doName: "s:main", sessionId: "s:main", ok: false },
  { name: "an id carrying a colon", doName: "abc:def", sessionId: "abc:def", ok: false },
];

// ------------------------------------------------------------------ the rule ----

check("SESSION_ID_RE is the one definition of a session id (R38)", () => {
  assert.ok(SESSION_ID_RE instanceof RegExp, "SESSION_ID_RE must be a RegExp");
  assert.equal(
    SESSION_ID_RE.source,
    "^[A-Za-z0-9_-]{1,40}$",
    "a second or widened definition of the id shape is the R38 defect"
  );
  // The ids this tree actually produces: the legacy conversation and a created one
  // (src/routes.ts takes 26 hex characters of a UUIDv4 with the dashes removed).
  assert.equal(isSessionId("main"), true, "main is a session id with no special case (R38)");
  assert.equal(
    isSessionId("0123456789abcdef0123456789abcdef".slice(0, 26)),
    true,
    "a generated 26-hex id must pass, or every create is followed by a 400"
  );
  assert.equal(isSessionId("s:main"), false, "the deleted prefix must not be reachable (R38)");
});

// The name that owns global memory and the scheduler tick (R45, R46) lives HERE, next to
// the rule that makes it a session id, because src/agent.ts, src/registry.ts and
// src/index.ts all address the same DO. A literal in a second file is the drift.
check("MAIN_DO_NAME is the one spelling of the name the guards and the seed share", () => {
  assert.equal(MAIN_DO_NAME, "main", "R38: the legacy DO name is a bare session id");
  assert.equal(isSessionId(MAIN_DO_NAME), true, "main must pass the shape rule with no special case");
  for (const file of ["agent.ts", "registry.ts", "index.ts"]) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.match(
      source,
      /MAIN_DO_NAME/,
      `${file} must import MAIN_DO_NAME rather than define or spell its own copy`
    );
    assert.equal(
      /const (MAIN_DO_NAME|LEGACY_SESSION_ID) = "main"/.test(source),
      false,
      `${file} redefines the main name locally`
    );
  }
});

// --------------------------------------------------------- sessionScopeOk ----

for (const testCase of CASES) {
  check(`sessionScopeOk answers ${testCase.ok} for ${testCase.name}`, () => {
    assert.equal(
      sessionScopeOk(ctxFor(testCase.doName), idFromName, testCase.sessionId),
      testCase.ok
    );
  });
}

check("sessionScopeOk is pure over its arguments", () => {
  // Same name, different fixture objects: the answer comes from the strings, not
  // from object identity, so a DO and a test can both build the arguments.
  assert.equal(sessionScopeOk(ctxFor("abc"), idFromName, "abc"), true);
  assert.equal(sessionScopeOk(ctxFor("abc"), idFromName, "abc"), true);
  // A namespace whose ids do not round-trip the name rejects the id it is given.
  const opaque = () => ({ toString: () => "do:someone-elses-session" });
  assert.equal(sessionScopeOk(ctxFor("abc"), opaque, "abc"), false);
});

// ------------------------------------------------------ assertSessionScope ----

for (const testCase of CASES) {
  check(`assertSessionScope agrees with sessionScopeOk for ${testCase.name}`, () => {
    if (testCase.ok) {
      assert.equal(
        assertSessionScope(ctxFor(testCase.doName), idFromName, testCase.sessionId),
        undefined,
        "the throwing form returns normally when the predicate holds"
      );
      return;
    }
    let thrown = null;
    try {
      assertSessionScope(ctxFor(testCase.doName), idFromName, testCase.sessionId);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof ScopeError, `expected a ScopeError, got ${String(thrown)}`);
    assert.ok(thrown instanceof Error, "ScopeError extends Error");
    assert.equal(thrown.name, "ScopeError");
    assert.ok(
      typeof thrown.message === "string" && thrown.message.includes(testCase.sessionId),
      `the message must name the refused id, got ${JSON.stringify(thrown.message)}`
    );
  });
}

// --------------------------------------------------------- dependency-free ----

check("src/session-scope.ts imports nothing at all (R47, so R39 keeps routes.ts honest)", () => {
  const source = readFileSync(new URL("../src/session-scope.ts", import.meta.url), "utf8");
  assert.equal(
    /^\s*import\b/m.test(source),
    false,
    "any import, even a type-only one of a module that reaches cloudflare:workers, makes this file unimportable from src/routes.ts"
  );
  assert.equal(
    /\brequire\s*\(/.test(source),
    false,
    "a require() is a runtime dependency the offline resolver cannot supply"
  );
});

// ------------------------------------------------------------------ summary ----

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`session-scope: ${failures.length} failed`);
  process.exit(1);
}
