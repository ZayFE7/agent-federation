// Task 4 pins the sandbox home path to one source of truth and refuses to let
// the agent promise a directory that cannot exist on the live sandbox.
// Plain Node, no framework: run with `node tests/paths.test.mjs`.
// Node 22.6+/24 strips the .ts types on import, so this needs no build step.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SANDBOX_HOME, EXPECTED_TOOLS } from "../src/capabilities.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const agentSrc = readFileSync(join(root, "src", "agent.ts"), "utf8");
const sandboxSrc = readFileSync(join(root, "deploy", "sandbox-worker", "src", "index.ts"), "utf8");

// The snapshot endpoint URL is a route name on the zay-sandbox worker, not a
// directory inside the microVM. Task 4 carves it out; Task 30 owns renaming it.
const ENDPOINT = "zay-sandbox/workspace/snapshot";

const failures = [];
let checks = 0;

function check(name, fn) {
  checks++;
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

check("SANDBOX_HOME is the real E2B home", () => {
  assert.equal(SANDBOX_HOME, "/home/user");
});

check("EXPECTED_TOOLS is the six wired tools, frozen", () => {
  assert.deepEqual([...EXPECTED_TOOLS], [
    "exec",
    "web_search",
    "schedule_task",
    "save_workspace",
    "plan",
    "plan_done",
  ]);
  assert.ok(Object.isFrozen(EXPECTED_TOOLS), "EXPECTED_TOOLS must be frozen");
});

check("src/agent.ts names no /workspace directory", () => {
  const withoutEndpoint = agentSrc.split(ENDPOINT).join("");
  const hits = withoutEndpoint.match(/\/workspace/g) || [];
  assert.equal(hits.length, 0, `${hits.length} /workspace occurrence(s) left in src/agent.ts`);
});

check("sandbox worker declares its own SANDBOX_HOME", () => {
  const m = sandboxSrc.match(/const SANDBOX_HOME = "([^"]*)"/);
  assert.ok(m, "no `const SANDBOX_HOME = \"...\"` in the sandbox worker");
  assert.equal(m[1], "/home/user");
});

check("sandbox worker never mkdirs /workspace", () => {
  assert.equal(sandboxSrc.includes("mkdir -p /workspace"), false);
});

check("every /workspace in the sandbox worker is the route name", () => {
  // The snapshot endpoint path stays until Task 30 renames it; nothing else may
  // name the directory.
  const route = 'url.pathname === "/workspace/snapshot"';
  assert.ok(sandboxSrc.includes(route), "the snapshot route name changed; update this test and Task 30");
  const withoutRoute = sandboxSrc.split(route).join("");
  const hits = withoutRoute.match(/\/workspace/g) || [];
  assert.equal(hits.length, 0, `${hits.length} /workspace occurrence(s) left in the sandbox worker`);
});

check("/run executes inside SANDBOX_HOME", () => {
  const call = sandboxSrc.match(/commands\.run\(body\.cmd, \{[^}]*\}/);
  assert.ok(call, "the /run commands.run call was not found");
  assert.match(call[0], /cwd: SANDBOX_HOME/);
});

check("snapshot and restore point at the same directory", () => {
  const pack = sandboxSrc.match(/cd \$\{SANDBOX_HOME\} && tar czf/);
  const unpack = sandboxSrc.match(/cd \$\{SANDBOX_HOME\} && echo/);
  assert.ok(pack, "snapshot does not cd into SANDBOX_HOME");
  assert.ok(unpack, "restore does not cd into SANDBOX_HOME");
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`paths: ${failures.length} of ${checks} failed`);
  process.exit(1);
}
console.log(`paths: ${checks} checks, 0 failed`);
