// Guards the one script that used to carry live provider secrets.
// Run with the rest of the offline suite: `node tests/secrets.test.mjs`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../deploy/sandbox-worker/put-secrets.mjs", import.meta.url),
  "utf8"
);

assert.match(source, /process\.env\.E2B_API_KEY/, "the E2B key must come from the environment");
assert.match(source, /process\.env\.SBOX_TOKEN/, "the sandbox token must come from the environment");
assert.doesNotMatch(source, /e2b_[a-f0-9]{20,}/i, "a literal E2B key must never return");
assert.doesNotMatch(source, /["'][a-f0-9]{32}["']/i, "a literal 32-character token must never return");

console.log("secrets: no provider literals");
