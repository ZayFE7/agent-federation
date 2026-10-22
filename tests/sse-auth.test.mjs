// Contract tests for tokenOk (plan Task 22) and vaultAuthed (plan Task 35) in
// src/auth.ts. EventSource cannot set an Authorization header, so the GET stream
// route accepts ?token= as well; the vault gate does not. Both must fail closed on
// an unset or blank secret.
// Plain Node: `node tests/sse-auth.test.mjs`. Silent on success (exit 0).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tokenOk, vaultAuthed } from "../src/auth.ts";

const failures = [];

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

const AUTH_SOURCE = readFileSync(new URL("../src/auth.ts", import.meta.url), "utf8");

const url = (query = "") => new URL(`https://blip.test/api/sessions/abc/stream/s:abc:op1${query}`);
const request = (headers = {}) => new Request("https://blip.test/x", { headers });
const env = (key) => ({ AGENT_API_KEY: key });

check("a query token matching the key is accepted", () => {
  assert.equal(tokenOk(request(), url("?token=k"), env("k")), true);
});

check("the Authorization header alone is accepted", () => {
  assert.equal(tokenOk(request({ authorization: "Bearer k" }), url(), env("k")), true);
});

check("a wrong query token is rejected", () => {
  assert.equal(tokenOk(request(), url("?token=wrong"), env("k")), false);
});

check("no token and no header is rejected", () => {
  assert.equal(tokenOk(request(), url(), env("k")), false);
  assert.equal(tokenOk(request(), url("?token="), env("k")), false, "an empty token is not a token");
});

check("an unset or whitespace-only key rejects both a header and a query token", () => {
  for (const key of ["", "   ", undefined]) {
    assert.equal(tokenOk(request({ authorization: "Bearer k" }), url(), env(key)), false, `header with key ${JSON.stringify(key)}`);
    assert.equal(tokenOk(request(), url("?token=k"), env(key)), false, `query with key ${JSON.stringify(key)}`);
  }
});

check("tokenOk compares through safeEq, never with ===", () => {
  assert.equal(/safeEq\(\s*query\s*,\s*key\s*\)/.test(AUTH_SOURCE), true, "the query token must go through safeEq");
  assert.equal(/safeEq\(\s*header\s*,\s*key\s*\)/.test(AUTH_SOURCE), true, "the header token must go through safeEq");
  assert.equal(/query\s*===\s*key|key\s*===\s*query/.test(AUTH_SOURCE), false, "a direct === on secrets is the bug safeEq exists to prevent");
});

// ---- vaultAuthed (plan Task 35) ----
// The DO vault routes carry their own STATE_KEY secret, separate from AGENT_API_KEY.
// A vault write is not an EventSource, so only the Bearer header counts and there is
// no ?token= exception. It must fail closed on an unset/blank key and never accept
// the literal "Bearer undefined" the old inline template produced.

const vaultEnv = (key) => ({ STATE_KEY: key });

check("vaultAuthed accepts the correct bearer token", () => {
  assert.equal(vaultAuthed(request({ authorization: "Bearer k1" }), vaultEnv("k1")), true);
});

check("vaultAuthed rejects a wrong bearer token", () => {
  assert.equal(vaultAuthed(request({ authorization: "Bearer nope" }), vaultEnv("k1")), false);
});

check("vaultAuthed fails closed when STATE_KEY is unset", () => {
  assert.equal(vaultAuthed(request({ authorization: "Bearer k1" }), vaultEnv(undefined)), false);
});

check("vaultAuthed fails closed when STATE_KEY is blank", () => {
  for (const key of ["", "   "]) {
    assert.equal(vaultAuthed(request({ authorization: "Bearer k1" }), vaultEnv(key)), false, `blank key ${JSON.stringify(key)}`);
  }
});

check("a Bearer undefined header never authenticates the vault", () => {
  // The fail-open fixed once for authed(): an unset key must not turn the header
  // string "undefined" into a match, and it must not match a real key either.
  assert.equal(vaultAuthed(request({ authorization: "Bearer undefined" }), vaultEnv(undefined)), false, "unset key rejects Bearer undefined");
  assert.equal(vaultAuthed(request({ authorization: "Bearer undefined" }), vaultEnv("k1")), false, "a real key is not the word undefined");
});

check("a ?token= query alone does not satisfy the vault gate", () => {
  const withQuery = new Request("https://blip.test/internal/vault/pull?token=k1");
  assert.equal(vaultAuthed(withQuery, vaultEnv("k1")), false, "the vault reads only the Bearer header, never ?token=");
});

check("vaultAuthed compares through safeEq, never with ===", () => {
  assert.equal(/safeEq\(\s*got\s*,\s*key\s*\)/.test(AUTH_SOURCE), true, "the vault bearer token must go through safeEq");
  assert.equal(/got\s*===\s*key|key\s*===\s*got/.test(AUTH_SOURCE), false, "a direct === on the vault secret is the bug safeEq exists to prevent");
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`sse-auth: ${failures.length} failed`);
  process.exit(1);
}
