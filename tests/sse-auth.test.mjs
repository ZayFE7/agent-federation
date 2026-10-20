// Contract tests for tokenOk in src/auth.ts (plan Task 22): EventSource cannot
// set an Authorization header, so the GET stream route accepts ?token= as well.
// Both halves must fail closed on an unset or blank AGENT_API_KEY.
// Plain Node: `node tests/sse-auth.test.mjs`. Silent on success (exit 0).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tokenOk } from "../src/auth.ts";

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

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`sse-auth: ${failures.length} failed`);
  process.exit(1);
}
