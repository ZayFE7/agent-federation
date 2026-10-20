// Deterministic directives: `run:` and `search:` short-circuit the model.
// P2-14 is the measured defect this pins out: the old regex matched `"run:  "`
// with a whitespace argument, trimmed it to "", and dispatched an empty command.
// Plain Node: `node tests/prefix.test.mjs`. Silent on success (exit 0).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseDirective } from "../src/directives.ts";

const here = dirname(fileURLToPath(import.meta.url));
const agentSrc = readFileSync(join(here, "..", "src", "agent.ts"), "utf8");

const failures = [];

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

check("run: yields an exec directive", () => {
  assert.deepEqual(parseDirective("run: echo hi"), { kind: "exec", arg: "echo hi" });
});

check("search: yields a search directive", () => {
  assert.deepEqual(parseDirective("search: cats"), { kind: "search", arg: "cats" });
});

check("RUN: matches case-insensitively", () => {
  assert.deepEqual(parseDirective("RUN: ls"), { kind: "exec", arg: "ls" });
});

check("exec: and execute: both match as exec", () => {
  assert.deepEqual(parseDirective("exec: ls"), { kind: "exec", arg: "ls" });
  assert.deepEqual(parseDirective("execute: ls"), { kind: "exec", arg: "ls" });
});

check("an empty argument does not match either arm (P2-14)", () => {
  assert.equal(parseDirective("run:  "), null);
  assert.equal(parseDirective("search:  "), null);
  assert.equal(parseDirective("exec: "), null);
  assert.equal(parseDirective("run:"), null);
});

check("the two arms do not swallow each other's prefixes", () => {
  assert.deepEqual(parseDirective("search: run: ls"), { kind: "search", arg: "run: ls" });
  assert.deepEqual(parseDirective("run: search: cats"), { kind: "exec", arg: "search: cats" });
});

check("a message that merely contains run: mid-sentence does not match", () => {
  assert.equal(parseDirective("please run: the tests"), null);
  assert.equal(parseDirective("can you search: for cats"), null);
  assert.equal(parseDirective("run the tests"), null);
});

check("the multi-line form still parses (s flag)", () => {
  assert.deepEqual(parseDirective("run:\necho hi"), { kind: "exec", arg: "echo hi" });
});

check("the dispatch site cannot run a directive with an empty arg", () => {
  // parseDirective never returns an empty arg (the guard inside it is the belt),
  // and the branches strip to a truthy command before any sandbox call.
  const execBranch = agentSrc.match(/if\s*\(directive\?\.kind === "exec"\)\s*\{[\s\S]*?\n {4}\}/)?.[0] ?? "";
  assert.ok(execBranch, "src/agent.ts has no exec directive branch to read");
  assert.ok(/const cmd = directive\.arg;/.test(execBranch), "the branch must take the parsed arg");
  assert.match(execBranch, /this\.runSandbox\(cmd, session\)/);
  assert.equal(/runSandbox\(\s*""/.test(agentSrc), false, "no empty-command dispatch may exist");
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`prefix: ${failures.length} failed`);
  process.exit(1);
}
