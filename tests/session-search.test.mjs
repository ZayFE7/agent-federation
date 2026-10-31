// Unit tests for src/session-search.ts: the query gate, snippet trimming, and the
// cross-session merge that src/routes.ts hands its per-session answers to.
//
// Plain Node, no framework: node tests/session-search.test.mjs. Silent on
// success; prints every failure and exits 1 otherwise.

import assert from "node:assert/strict";
import {
  clampSearchQuery,
  mergeSearchHits,
  searchSnippet,
} from "../src/session-search.ts";

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

check("clampSearchQuery trims, collapses whitespace, and enforces the 2..200 window", () => {
  assert.equal(clampSearchQuery("  deploy   notes "), "deploy notes");
  assert.equal(clampSearchQuery("ab"), "ab");
  assert.equal(clampSearchQuery("a"), null);
  assert.equal(clampSearchQuery(""), null);
  assert.equal(clampSearchQuery("   "), null);
  assert.equal(clampSearchQuery(null), null);
  assert.equal(clampSearchQuery("x".repeat(200)), "x".repeat(200));
  assert.equal(clampSearchQuery("x".repeat(201)), null);
});

check("searchSnippet keeps a short hit untouched and windows a long one", () => {
  assert.equal(searchSnippet("short reply", "short"), "short reply");
  const long = `${"a".repeat(500)} deploy ${"b".repeat(500)}`;
  const cut = searchSnippet(long, "deploy");
  assert.ok(cut.length < long.length, "a long hit is cut");
  assert.ok(cut.includes("deploy"), "the cut keeps the match");
  assert.ok(cut.startsWith("..."), "a middle window is marked at the front");
  assert.ok(cut.endsWith("..."), "a middle window is marked at the end");
});

check("searchSnippet without a match still bounds the text", () => {
  const cut = searchSnippet("z".repeat(900), "deploy");
  assert.equal(cut.length, 363, "360 characters plus the trailing marker");
});

check("mergeSearchHits attaches titles, stamps the session, and drops unknown rows", () => {
  const sessions = [
    { id: "a", title: "First chat" },
    { id: "b", title: "Second chat" },
  ];
  const rows = mergeSearchHits(
    [
      { id: "1", role: "user", content: "hello there", createdAt: "2026-10-01T00:00:00.000Z", sessionId: "a" },
      { id: "2", role: "assistant", content: "hello back", createdAt: "2026-10-02T00:00:00.000Z", sessionId: "b" },
      { id: "3", role: "user", content: "ghost", sessionId: "gone" },
    ],
    sessions,
    10,
    "hello"
  );
  assert.deepEqual(
    rows.map((row) => [row.sessionId, row.sessionTitle, row.id]),
    [
      ["b", "Second chat", "2"],
      ["a", "First chat", "1"],
    ]
  );
});

check("mergeSearchHits dedupes the same hit reported twice and respects the cap", () => {
  const sessions = [{ id: "a", title: "One" }];
  const rows = mergeSearchHits(
    [
      { id: "1", role: "user", content: "same text", sessionId: "a" },
      { id: "9", role: "user", content: "same text", sessionId: "a" },
      { id: "2", role: "assistant", content: "other", sessionId: "a" },
    ],
    sessions,
    1
  );
  assert.equal(rows.length, 1, "the cap is applied after dedupe");
});

check("mergeSearchHits keeps the order stable for equal or missing timestamps", () => {
  const sessions = [{ id: "a", title: "One" }];
  const rows = mergeSearchHits(
    [
      { id: "1", role: "user", content: "first", sessionId: "a" },
      { id: "2", role: "user", content: "second", sessionId: "a" },
    ],
    sessions,
    10
  );
  assert.deepEqual(rows.map((row) => row.id), ["1", "2"]);
});

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
