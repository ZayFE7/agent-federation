// Data-only condition matcher: operators, dotted paths, missing-path semantics,
// nesting caps, and rejection of anything that is not inert JSON data.

import assert from "node:assert/strict";
import { evaluateMatch, parseMatch } from "../src/automation-match.ts";

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
    console.log("  FAIL " + name);
  }
}

const leaf = (path, op, value) => (value === undefined ? { path, op } : { path, op, value });

check("a null match is unconditional and empty input parses to null", () => {
  assert.deepEqual(evaluateMatch(null, {}), { ok: true, reason: "no conditions" });
  assert.equal(parseMatch(null), null);
  assert.equal(parseMatch(""), null);
  assert.equal(parseMatch("null"), null);
  assert.equal(parseMatch("not json"), null);
});

check("all and nested any compose", () => {
  const match = {
    all: [
      leaf("action", "eq", "opened"),
      {
        any: [
          leaf("issue.labels", "contains", "bug"),
          leaf("issue.labels.0", "eq", "urgent"),
        ],
      },
    ],
  };
  assert.equal(evaluateMatch(match, { action: "opened", issue: { labels: ["bug"] } }).ok, true);
  assert.equal(
    evaluateMatch(match, { action: "opened", issue: { labels: ["urgent"] } }).ok,
    true
  );
  assert.equal(
    evaluateMatch(match, { action: "closed", issue: { labels: ["bug"] } }).ok,
    false
  );
  assert.equal(
    evaluateMatch(
      { any: [leaf("action", "eq", "opened"), leaf("action", "eq", "reopened")] },
      { action: "reopened" }
    ).ok,
    true
  );
  assert.equal(evaluateMatch({ all: [] }, {}).ok, true);
  assert.equal(evaluateMatch({ any: [] }, {}).ok, false);
});

check("every operator behaves on primitives", () => {
  const data = {
    action: "opened",
    title: "hello world",
    count: 5,
    draft: false,
    nil: null,
    tags: ["bug", "ui"],
  };
  assert.equal(evaluateMatch(leaf("action", "eq", "opened"), data).ok, true);
  assert.equal(evaluateMatch(leaf("action", "eq", "closed"), data).ok, false);
  assert.equal(evaluateMatch(leaf("action", "neq", "closed"), data).ok, true);
  assert.equal(evaluateMatch(leaf("title", "contains", "lo wo"), data).ok, true);
  assert.equal(evaluateMatch(leaf("tags", "contains", "ui"), data).ok, true);
  assert.equal(evaluateMatch(leaf("tags", "contains", "nope"), data).ok, false);
  assert.equal(evaluateMatch(leaf("title", "startsWith", "hello"), data).ok, true);
  assert.equal(evaluateMatch(leaf("title", "endsWith", "world"), data).ok, true);
  assert.equal(evaluateMatch(leaf("title", "endsWith", "hello"), data).ok, false);
  assert.equal(evaluateMatch(leaf("count", "gt", 4), data).ok, true);
  assert.equal(evaluateMatch(leaf("count", "gt", 5), data).ok, false);
  assert.equal(evaluateMatch(leaf("count", "lt", 6), data).ok, true);
  assert.equal(evaluateMatch(leaf("action", "in", ["opened", "reopened"]), data).ok, true);
  assert.equal(evaluateMatch(leaf("action", "in", ["closed"]), data).ok, false);
  assert.equal(evaluateMatch(leaf("draft", "exists"), data).ok, true);
  assert.equal(evaluateMatch(leaf("nil", "exists"), data).ok, true);
  assert.equal(evaluateMatch(leaf("missing", "exists"), data).ok, false);
  // Numeric comparisons do not coerce strings.
  assert.equal(evaluateMatch(leaf("action", "gt", 1), data).ok, false);
});

check("dotted paths index into arrays", () => {
  const data = { items: [{ name: "a" }, { name: "b" }], nested: { deep: { value: 7 } } };
  assert.equal(evaluateMatch(leaf("items.1.name", "eq", "b"), data).ok, true);
  assert.equal(evaluateMatch(leaf("items.2.name", "eq", "b"), data).ok, false);
  assert.equal(evaluateMatch(leaf("nested.deep.value", "eq", 7), data).ok, true);
  assert.equal(evaluateMatch(leaf("items.name", "eq", "a"), data).ok, false);
});

check("missing paths fail everything except neq and exists-false", () => {
  const data = { present: 1 };
  for (const op of ["eq", "contains", "startsWith", "endsWith", "gt", "lt", "in"]) {
    const result = evaluateMatch(leaf("absent", op, op === "in" ? [1] : 1), data);
    assert.equal(result.ok, false, `${op} should fail on a missing path`);
  }
  assert.equal(evaluateMatch(leaf("absent", "exists"), data).ok, false);
  assert.equal(evaluateMatch(leaf("absent", "neq", 1), data).ok, true);
});

check("parseMatch accepts valid JSON and evaluates the normalized tree", () => {
  const json = JSON.stringify({
    all: [
      { path: "action", op: "eq", value: "opened" },
      { path: "issue.labels", op: "contains", value: "bug" },
    ],
  });
  const match = parseMatch(json);
  assert.ok(match);
  assert.equal(evaluateMatch(match, { action: "opened", issue: { labels: ["bug"] } }).ok, true);
});

check("parseMatch caps total nodes at 32", () => {
  const leaves = (count) =>
    Array.from({ length: count }, (_, index) => leaf(`p${index}`, "exists"));
  assert.ok(parseMatch(JSON.stringify({ all: leaves(31) })));
  assert.equal(parseMatch(JSON.stringify({ all: leaves(32) })), null);
  assert.equal(parseMatch(JSON.stringify(leaves(32))), null);
});

check("parseMatch caps nesting depth at 3", () => {
  const okTree = { all: [{ any: [leaf("a", "eq", 1)] }] };
  assert.ok(parseMatch(JSON.stringify(okTree)));
  const tooDeep = { all: [{ any: [{ all: [leaf("a", "eq", 1)] }] }] };
  assert.equal(parseMatch(JSON.stringify(tooDeep)), null);
});

check("parseMatch rejects unknown ops, keys, and non-data values", () => {
  assert.equal(parseMatch(JSON.stringify(leaf("a", "regex", "x"))), null);
  assert.equal(parseMatch(JSON.stringify(leaf("a", "constructor", "x"))), null);
  assert.equal(parseMatch(JSON.stringify({ path: "a", op: "eq", value: 1, script: "x" })), null);
  assert.equal(parseMatch(JSON.stringify({ all: [leaf("a", "eq", 1)], extra: true })), null);
  assert.equal(parseMatch(JSON.stringify({ path: "a", op: "eq" })), null);
  assert.equal(parseMatch(JSON.stringify({ op: "eq", value: 1 })), null);
  assert.equal(parseMatch(JSON.stringify({ path: "a", value: 1 })), null);
  assert.equal(parseMatch(JSON.stringify(leaf("a", "eq", { nested: true }))), null);
  assert.equal(parseMatch(JSON.stringify(leaf("a", "contains", [["nested"]]))), null);
  assert.equal(parseMatch(JSON.stringify(leaf("a", "in", "not-an-array"))), null);
  assert.equal(parseMatch(JSON.stringify({ path: "a..b", op: "eq", value: 1 })), null);
  assert.equal(parseMatch(JSON.stringify(leaf("__proto__.polluted", "eq", 1))), null);
  assert.equal(parseMatch(JSON.stringify([leaf("a", "eq", 1)])), null);
  assert.equal(parseMatch(JSON.stringify({ all: "no" })), null);
});

check("parseMatch caps input size at 8 KB", () => {
  const huge = JSON.stringify(leaf("a", "eq", "x".repeat(9 * 1024)));
  assert.equal(parseMatch(huge), null);
});

check("values are data only: function-like strings never execute", () => {
  const match = parseMatch(
    JSON.stringify({ path: "command", op: "eq", value: "process.exit(1)" })
  );
  assert.ok(match);
  assert.equal(evaluateMatch(match, { command: "process.exit(1)" }).ok, true);
  assert.equal(evaluateMatch(match, { command: "rm -rf" }).ok, false);
});

if (failures.length) {
  for (const failure of failures) console.error("  FAIL " + failure);
  process.exit(1);
}
console.log("automation match: passed");
