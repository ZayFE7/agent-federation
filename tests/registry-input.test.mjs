// Contract tests for src/registry-input.ts: the pure input handling behind the
// registry DO's /registry/... surface. Executed, not regexed (R64 I3): this is the
// first offline proof that the DO's parsing does what it claims, because
// src/registry.ts itself is not importable by Node.
// Plain Node, no framework, no build step: run with `node tests/registry-input.test.mjs`.
//
// Silent on success (exit 0). Prints every failure and exits 1 otherwise.

import assert from "node:assert/strict";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  idFromSegment,
  limitFrom,
  readJson,
  rowFrom,
  wholeNumber,
} from "../src/registry-input.ts";

const failures = [];

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

const params = (query) => new URLSearchParams(query);
const VALID = { id: "abc", title: "Drafts", created_at: 1000, updated_at: 2000 };

check("the limit contract matches the route default and ceiling Task 7 documents", () => {
  assert.equal(DEFAULT_LIMIT, 50);
  assert.equal(MAX_LIMIT, 200);
});

check("limitFrom defaults on garbage, on an absent param, and on 0 or negative", () => {
  assert.equal(limitFrom(params("")), DEFAULT_LIMIT);
  assert.equal(limitFrom(params("limit=abc")), DEFAULT_LIMIT);
  assert.equal(limitFrom(params("limit=")), DEFAULT_LIMIT);
  assert.equal(limitFrom(params("limit=Infinity")), DEFAULT_LIMIT);
  assert.equal(limitFrom(params("limit=NaN")), DEFAULT_LIMIT);
  assert.equal(limitFrom(params("limit=0")), DEFAULT_LIMIT);
  assert.equal(limitFrom(params("limit=-3")), DEFAULT_LIMIT);
  assert.equal(limitFrom(params("limit=-0.5")), DEFAULT_LIMIT);
});

check("limitFrom clamps the ceiling at MAX_LIMIT and floors a fraction", () => {
  assert.equal(limitFrom(params("limit=99999")), 200);
  assert.equal(limitFrom(params("limit=201")), 200);
  assert.equal(limitFrom(params("limit=200")), 200);
  assert.equal(limitFrom(params("limit=12.7")), 12);
  assert.equal(limitFrom(params("limit=1")), 1);
});

check("limitFrom reads only the limit param and ignores its neighbours", () => {
  assert.equal(limitFrom(params("limit=7&workspace=x")), 7);
  assert.equal(limitFrom(params("workspace=x")), DEFAULT_LIMIT);
});

check("idFromSegment decodes a percent-escaped segment", () => {
  assert.equal(idFromSegment("main%20x"), "main x");
  assert.equal(idFromSegment("abc123"), "abc123");
  assert.equal(idFromSegment("a%2Fb"), "a/b");
  assert.equal(idFromSegment(""), "");
});

check("idFromSegment returns the empty string for a lone percent", () => {
  assert.equal(idFromSegment("%"), "");
  assert.equal(idFromSegment("%zz"), "");
  assert.equal(idFromSegment("main%"), "");
});

check("wholeNumber takes whole numbers only, and 0 is a number", () => {
  assert.equal(wholeNumber(5), 5);
  assert.equal(wholeNumber(0), 0);
  assert.equal(wholeNumber(-4), -4);
});

check("wholeNumber rejects fractions, non-finite values and non-numbers", () => {
  for (const value of [1.5, -0.5, 0.1, NaN, Infinity, -Infinity, "3", "", true, false, null, undefined, {}, []]) {
    assert.equal(wholeNumber(value), null, `wholeNumber(${JSON.stringify(value)}) must be null`);
  }
});

check("rowFrom accepts a full row and reads every column as sent", () => {
  assert.deepEqual({ ...rowFrom({ ...VALID, workspace_ref: "ws", unread: 2, pinned: 1 }) }, {
    id: "abc",
    title: "Drafts",
    created_at: 1000,
    updated_at: 2000,
    workspace_ref: "ws",
    unread: 2,
    pinned: 1,
  });
});

check("rowFrom rejects a missing or empty id and a missing or empty title", () => {
  assert.equal(rowFrom({ ...VALID, id: undefined }), null, "a missing id must be rejected");
  assert.equal(rowFrom({ ...VALID, id: "" }), null, "an empty id must be rejected");
  assert.equal(rowFrom({ ...VALID, id: 7 }), null, "a non-string id must be rejected");
  assert.equal(rowFrom({ ...VALID, title: undefined }), null, "a missing title must be rejected");
  assert.equal(rowFrom({ ...VALID, title: "" }), null, "an empty title must be rejected");
  assert.equal(rowFrom({ ...VALID, title: 7 }), null, "a non-string title must be rejected");
});

check("rowFrom rejects a non-object body", () => {
  assert.equal(rowFrom(null), null);
  assert.equal(rowFrom(undefined), null);
  assert.equal(rowFrom("abc"), null);
  assert.equal(rowFrom(42), null);
  assert.equal(rowFrom([]), null);
  assert.equal(rowFrom(true), null);
});

check("rowFrom rejects a missing or non-number created_at and updated_at", () => {
  assert.equal(rowFrom({ id: "a", title: "t", updated_at: 1 }), null, "created_at is required");
  assert.equal(rowFrom({ id: "a", title: "t", created_at: 1 }), null, "updated_at is required");
  assert.equal(rowFrom({ ...VALID, created_at: "1000" }), null);
  assert.equal(rowFrom({ ...VALID, updated_at: null }), null);
});

check("rowFrom rejects a fractional created_at, updated_at, unread or pinned", () => {
  assert.equal(rowFrom({ ...VALID, created_at: 1000.5 }), null, "a fractional created_at leaked through");
  assert.equal(rowFrom({ ...VALID, updated_at: 2000.5 }), null, "a fractional updated_at leaked through");
  assert.equal(rowFrom({ ...VALID, unread: 0.5 }), null, "a fractional unread leaked through: the badge arithmetic would drift");
  assert.equal(rowFrom({ ...VALID, pinned: 1.5 }), null, "a fractional pinned leaked through");
});

check("rowFrom defaults an absent workspace_ref, unread and pinned", () => {
  assert.deepEqual({ ...rowFrom(VALID) }, {
    id: "abc",
    title: "Drafts",
    created_at: 1000,
    updated_at: 2000,
    workspace_ref: null,
    unread: 0,
    pinned: 0,
  });
  assert.equal(rowFrom({ ...VALID, workspace_ref: null }).workspace_ref, null);
  assert.equal(rowFrom({ ...VALID, workspace_ref: 5 }).workspace_ref, null, "a non-string ref is null, not coerced");
  assert.equal(rowFrom({ ...VALID, unread: null }).unread, 0);
  assert.equal(rowFrom({ ...VALID, pinned: null }).pinned, 0);
  assert.equal(rowFrom({ ...VALID, unread: 0 }).unread, 0, "an explicit 0 is not read as absent");
});

check("rowFrom keeps an empty workspace_ref as the empty string it was sent as", () => {
  assert.equal(rowFrom({ ...VALID, workspace_ref: "" }).workspace_ref, "");
});

function checkAsync(name, fn) {
  return fn().catch((err) => {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  });
}

const post = (body) =>
  new Request("http://registry.local/registry/sessions", { method: "POST", body });

await checkAsync("readJson returns null for a malformed or empty body", async () => {
  assert.equal(await readJson(post("{ not json")), null, "a malformed body must read as null, not throw");
  assert.equal(await readJson(post("")), null, "an empty body must read as null");
  assert.equal(await readJson(post("{not:}")), null);
});

await checkAsync("readJson parses a JSON body and rowFrom consumes it", async () => {
  assert.deepEqual(await readJson(post('{"id":"a"}')), { id: "a" });
  assert.equal(await readJson(post("null")), null);
  assert.deepEqual(
    { ...rowFrom(await readJson(post(JSON.stringify(VALID)))) },
    { ...VALID, workspace_ref: null, unread: 0, pinned: 0 }
  );
  assert.equal(rowFrom(await readJson(post(JSON.stringify({ ...VALID, unread: 0.5 })))), null);
  assert.equal(rowFrom(await readJson(post(JSON.stringify({ ...VALID, created_at: 1.5 })))), null);
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`registry-input: ${failures.length} failed`);
  process.exit(1);
}
