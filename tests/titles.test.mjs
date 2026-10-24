// Contract tests for src/titles.ts, the dependency-free title parser and prompt
// that Task 9 wires into a fire-and-forget fiber after the chat reply exists.
// Plain Node, no framework, no build step: run with `node tests/titles.test.mjs`.
// Silent on success (exit 0). Prints every failure and exits 1 otherwise.
//
// The astral fixture is written as an escape so the test stays readable and the
// file carries no emoji literal. U+1F680 is one codepoint but two UTF-16 units,
// which is exactly the case a UTF-16 `slice(0, 40)` would split in half.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TITLE_MAX_TOKENS, TITLE_SYSTEM, parseTitle, provisionalTitle, titleMessages } from "../src/titles.ts";

const ASTRAL = "\u{1F680}";

/** Count codepoints, not UTF-16 units, so the astral fixture counts as one. */
const chars = (s) => Array.from(s);

const failures = [];

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

// ---- parseTitle ----

check("parseTitle trims surrounding whitespace", () => {
  assert.equal(parseTitle("  Hello World  ", "fallback"), "Hello World");
});

check("parseTitle strips the wrapping quotes a model often adds", () => {
  assert.equal(parseTitle('"Build a Tracker"', "fallback"), "Build a Tracker");
});

check("parseTitle cuts a 60-char title at a word boundary at 40 codepoints or fewer", () => {
  const raw = `Plan a weekend trip to the mountains ${ASTRAL} and pack light today!`;
  const out = parseTitle(raw, "fallback");
  // The last whitespace in the first 40 codepoints sits before "and"; the
  // astral codepoint at index 37 is inside the cut, so this also proves the
  // boundary is counted in codepoints rather than in UTF-16 units.
  assert.equal(chars(raw).length, 60, "fixture is 60 codepoints");
  assert.equal(out, `Plan a weekend trip to the mountains ${ASTRAL}`);
  assert.ok(chars(out).length <= 40, `cut to ${chars(out).length} codepoints`);
});

check("parseTitle hard-cuts one 60-char word at 40 codepoints without splitting a surrogate pair", () => {
  const raw = "a".repeat(39) + ASTRAL + "b".repeat(20);
  const expected = "a".repeat(39) + ASTRAL;
  const out = parseTitle(raw, "fallback");
  assert.equal(chars(raw).length, 60, "fixture is 60 codepoints");
  assert.equal(out, expected, "hard cut must keep the whole astral codepoint");
  assert.equal(chars(out).length, 40, "hard cut lands at 40 codepoints");
  assert.equal(out.length, 41, "the astral codepoint is still two UTF-16 units");
  // A naive `raw.slice(0, 40)` ends with a lone high surrogate.
  assert.notEqual(out, raw.slice(0, 40), "the surrogate pair was split");
});

check("parseTitle returns the fallback when the reply is empty or blank", () => {
  assert.equal(parseTitle("", "Fallback title"), "Fallback title");
  assert.equal(parseTitle("   \n\t ", "Fallback title"), "Fallback title");
});

check("parseTitle truncates a long fallback to 40 chars plus an ASCII ellipsis", () => {
  const fallback = "z".repeat(60);
  assert.equal(parseTitle("", fallback), "z".repeat(40) + "...");
});

check("parseTitle reads the JSON object form the cheap model often returns", () => {
  assert.equal(parseTitle('{"title":"X"}', "fallback"), "X");
  assert.equal(parseTitle('{ "title": "Weekly Revenue" }', "fallback"), "Weekly Revenue");
  assert.equal(parseTitle('```json\n{"title":"Fix Login Bug"}\n```', "fallback"), "Fix Login Bug");
});

// ---- titleMessages ----

check("titleMessages sends the system prompt and the first user message", () => {
  const msgs = titleMessages("hello there");
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[0], { role: "system", content: TITLE_SYSTEM });
  assert.deepEqual(msgs[1], { role: "user", content: "hello there" });
});

check("titleMessages includes at most the first 300 chars of the user message", () => {
  const long = "a".repeat(500);
  const user = titleMessages(long)[1];
  assert.equal(user.role, "user");
  assert.equal(user.content, long.slice(0, 300));
  assert.ok(user.content.length <= 300, `sent ${user.content.length} chars`);
  assert.equal(user.content.length, 300);
});

check("TITLE_SYSTEM pins the format the parser depends on", () => {
  assert.match(TITLE_SYSTEM, /two to five words/i);
  assert.match(TITLE_SYSTEM, /sentence case/i);
  assert.match(TITLE_SYSTEM, /no quotes/i);
  assert.match(TITLE_SYSTEM, /no trailing period/i);
  assert.match(TITLE_SYSTEM, /no emoji/i);
  assert.ok(
    TITLE_SYSTEM.includes('{"title":"..."}'),
    "TITLE_SYSTEM does not name the JSON object form"
  );
});

// ---- the completion budget ----

check("a provisional title lands immediately from the user's words", () => {
  assert.equal(provisionalTitle("run: echo hello"), "echo hello");
  assert.equal(
    provisionalTitle("Use Python to print the 67th prime number and the first 67 digits of pi"),
    "Use Python to print the 67th"
  );
  assert.equal(provisionalTitle("```sh\necho hidden\n```"), "");
  assert.equal(provisionalTitle("https://example.com/very/long/path"), "");
  assert.ok(Array.from(provisionalTitle("one two three four five six seven")).length <= 40);
});

check("TITLE_MAX_TOKENS leaves room for reasoning before content", () => {
  assert.ok(Number.isInteger(TITLE_MAX_TOKENS), "TITLE_MAX_TOKENS is not an integer");
  assert.ok(
    TITLE_MAX_TOKENS >= 256,
    `TITLE_MAX_TOKENS is ${TITLE_MAX_TOKENS}; qwen spent all 60 on reasoning and returned null content`
  );
});

check("agent.ts spends TITLE_MAX_TOKENS rather than a small literal", () => {
  const src = readFileSync(new URL("../src/agent.ts", import.meta.url), "utf8");
  assert.match(src, /max_tokens: TITLE_MAX_TOKENS\b/);
  assert.doesNotMatch(src, /max_tokens: 60\b/);
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`titles: ${failures.length} failed`);
  process.exit(1);
}
