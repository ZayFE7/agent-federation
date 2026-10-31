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
const toolsSrc = readFileSync(join(root, "src", "tools.ts"), "utf8");
const sandboxSrc = readFileSync(join(root, "deploy", "sandbox-worker", "src", "index.ts"), "utf8");
const workspaceSrc = readFileSync(join(root, "deploy", "sandbox-worker", "workspace.ts"), "utf8");

// The snapshot endpoint URLs are route names on the zay-sandbox worker, not
// directories inside the microVM. Task 4 carves them out; Task 30 owns renaming.
const ENDPOINT = "zay-sandbox/workspace/snapshot";

const failures = [];
let checks = 0;

const ROUTES = [
  "/workspace/snapshot",
  "/workspace/restore",
  "/workspace/manifest",
  "/workspace/archive",
  "/workspace/forget",
  "/workspace/write",
  "/workspace/files",
  "/workspace/read",
  "/workspace/upload",
  "/workspace/put",
  "/workspace/copy",
];

function check(name, fn) {
  checks++;
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

// The thing being forbidden is a directory at the root of the microVM, not the
// substring. A comment may cite `src/workspace-keys.ts` and an import may say
// `../workspace`; neither can be mkdir'd. A name preceded by a word character or
// a dot is one of those, so only `/workspace` standing on its own is a hit.
const ROOT_WORKSPACE = /[^.\w]\/workspace\b/g;

function rootHits(source) {
  return source.match(ROOT_WORKSPACE) || [];
}

check("SANDBOX_HOME is the real E2B home", () => {
  assert.equal(SANDBOX_HOME, "/home/user");
});

check("EXPECTED_TOOLS is the twenty-two wired tools, frozen", () => {
  assert.deepEqual([...EXPECTED_TOOLS], [
    "exec",
    "lookup_online",
    "schedule_task",
    "delegate",
    "mcp_call",
    "skill",
    "skill_install",
    "write_file",
    "remember",
    "automation_create",
    "automation_status",
    "automation_control",
    "gmail",
    "calendar",
    "tasks",
    "youtube_transcript",
    "generate_image",
    "generate_speech",
    "transcribe_media",
    "goal_create",
    "goal_status",
    "goal_control",
  ]);
  assert.ok(Object.isFrozen(EXPECTED_TOOLS), "EXPECTED_TOOLS must be frozen");
});

check("src/tools.ts names no /workspace directory", () => {
  const withoutEndpoint = toolsSrc.split(ENDPOINT).join("");
  const hits = rootHits(withoutEndpoint);
  assert.equal(hits.length, 0, `${hits.length} /workspace occurrence(s) left in src/tools.ts`);
});

check("sandbox worker declares its own SANDBOX_HOME", () => {
  const m = sandboxSrc.match(/const SANDBOX_HOME = "([^"]*)"/);
  assert.ok(m, "no `const SANDBOX_HOME = \"...\"` in the sandbox worker");
  assert.equal(m[1], "/home/user");
});

check("sandbox worker never mkdirs /workspace", () => {
  assert.equal(sandboxSrc.includes("mkdir -p /workspace"), false);
});

check("every /workspace in the sandbox worker is a route name", () => {
  // The workspace endpoint paths stay until Task 30 renames them; nothing
  // else in this worker may name a directory.
  let withoutRoutes = sandboxSrc;
  for (const route of ROUTES) {
    assert.ok(
      sandboxSrc.includes(`"${route}"`),
      `the ${route} route name changed or vanished; update this test and Task 30`
    );
    withoutRoutes = withoutRoutes.split(`"${route}"`).join("");
  }
  const hits = rootHits(withoutRoutes);
  assert.equal(hits.length, 0, `${hits.length} /workspace occurrence(s) left in the sandbox worker`);
});

check("/run executes inside SANDBOX_HOME", () => {
  const call = sandboxSrc.match(/commands\.run\(body\.cmd, \{[^}]*\}/);
  assert.ok(call, "the /run commands.run call was not found");
  assert.match(call[0], /cwd: SANDBOX_HOME/);
});

check("the worker hands its own SANDBOX_HOME to both snapshot and restore", () => {
  // Task 27 moved the tar into workspace.ts, which takes the home as a
  // parameter. The one source of truth still has to be this worker's constant,
  // not workspace.ts's default, or the two deploys can drift apart silently.
  const homes = sandboxSrc.match(/home: SANDBOX_HOME/g) || [];
  // Four sites since Task 28: the snapshot route, the restore route, the cold-boot
  // restore, and the save an eviction makes before it kills another session's VM.
  assert.equal(homes.length, 4, `expected snapshot, restore, boot restore, and the pre-eviction save to pass it, saw ${homes.length}`);
  assert.equal(sandboxSrc.includes("home: DEFAULT_HOME"), false);
});

check("pack and unpack inside the sandbox cd into the same home", () => {
  const pack = workspaceSrc.match(/cd \$\{home\} && tar czf/);
  const unpack = workspaceSrc.match(/cd \$\{home\} && tar xzf/);
  assert.ok(pack, "snapshot does not cd into the home it was passed");
  assert.ok(unpack, "restore does not cd into the home it was passed");
  // The shape that died at MAX_ARG_STRLEN was a base64 blob echoed into a shell
  // argument. Prose may mention it; a command may not build one.
  assert.equal(/echo\s+['"]/.test(workspaceSrc), false, "base64-in-a-shell-argument is back");
});

check("workspace.ts names no directory the worker owns", () => {
  const hits = rootHits(workspaceSrc);
  assert.equal(hits.length, 0, `${hits.length} /workspace occurrence(s) in workspace.ts`);
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`paths: ${failures.length} of ${checks} failed`);
  process.exit(1);
}
console.log(`paths: ${checks} checks, 0 failed`);
