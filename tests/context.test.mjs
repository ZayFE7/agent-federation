// Unit tests for src/capabilities.ts: the one table every capability claim
// renders from, and the one system-prompt assembler. Plain Node:
// `node tests/context.test.mjs`. Silent on success (exit 0).

import assert from "node:assert/strict";
import {
  SANDBOX_HOME,
  capabilitiesText,
  capabilityList,
  buildSystemPrompt,
  isCapabilityQuestion,
} from "../src/capabilities.ts";

const failures = [];

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

const wired = capabilitiesText(["exec", "lookup_online"]);

check("wired tools are described; unwired features are absent", () => {
  assert.match(wired, /Linux sandbox/);
  assert.match(wired, /Web search/);
  for (const claim of [/browser/i, /email/i, /sub-agents/i, /MCP/i]) {
    assert.equal(claim.test(wired), false, `unwired claim leaked into the prompt: ${claim}`);
  }
});

check("adding delegate adds the multi-agent line and changes nothing else", () => {
  const withDelegate = capabilitiesText(["exec", "lookup_online", "delegate"]);
  const base = new Set(wired.split("\n"));
  const added = withDelegate.split("\n").filter((line) => !base.has(line));
  assert.equal(added.length, 1);
  assert.match(added[0], /Sub-agents/);
  assert.match(added[0], /delegate tool/);
  // New always-on rows can sit after Sub-agents; what matters is that every
  // wired line survives and only the delegate line is new.
  for (const line of base) {
    assert.equal(withDelegate.includes(line), true, `a wired line disappeared: ${line}`);
  }
});

check("the sandbox home is named in the shell claim", () => {
  assert.equal(SANDBOX_HOME, "/home/user");
  assert.equal(wired.includes("/home/user"), true);
});

check("unwired entries are listed but marked not wired", () => {
  const browser = capabilityList(["exec"]).find((c) => c.id === "browser");
  assert.ok(browser);
  assert.equal(browser.wired, false);
  const memory = capabilityList([]).find((c) => c.id === "memory");
  assert.equal(memory.wired, true, "core capabilities are always on");
});

check("only an unqualified capability question takes the deterministic answer", () => {
  assert.equal(isCapabilityQuestion("what can you do?"), true);
  assert.equal(isCapabilityQuestion("  What can you do  "), true);
  assert.equal(isCapabilityQuestion("what are your capabilities"), true);
  assert.equal(
    isCapabilityQuestion("what can you do with your built in computer?"),
    false,
    "a qualified question must reach the model, not the canned list"
  );
  assert.equal(isCapabilityQuestion("what can you do with Python files"), false);
});

const memories = [
  { id: 1, kind: "exchange", content: "User likes dark mode", importance: 2, created_at: 0, updated_at: 0 },
];
const prompt = buildSystemPrompt(memories, wired, SANDBOX_HOME);

check("memory comes after the tool guidance, so recency helps", () => {
  assert.ok(prompt.indexOf("Linux sandbox") < prompt.indexOf("Known memories"));
  assert.ok(prompt.indexOf("What you can do:") < prompt.indexOf("User likes dark mode"));
});

check("an empty memory store contributes no section at all", () => {
  const bare = buildSystemPrompt([], wired, SANDBOX_HOME);
  assert.equal(/Known memories/.test(bare), false);
  assert.equal(bare.includes("You have no memories"), false);
});

check("each memory is truncated to 400 chars", () => {
  const long = "x".repeat(600);
  const withLong = buildSystemPrompt(
    [{ id: 2, kind: "exchange", content: long, importance: 1, created_at: 0, updated_at: 0 }],
    wired,
    SANDBOX_HOME
  );
  assert.equal(withLong.includes("x".repeat(400)), true);
  assert.equal(withLong.includes("x".repeat(401)), false);
});

check("the prompt carries the persona, the hard rule and the home", () => {
  assert.match(prompt, /You are Blip/);
  assert.match(prompt, /say in one short sentence what you are about to do/);
  assert.match(prompt, /take it in the same turn instead of ending with a promise/);
  assert.match(prompt, /Never reply with a plan instead of acting/);
  assert.match(prompt, /Your sandbox home is \/home\/user/);
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`context: ${failures.length} failed`);
  process.exit(1);
}
