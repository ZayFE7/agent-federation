#!/usr/bin/env node
// Offline test harness. Spawns every tests/*.test.mjs on plain Node, one child
// per file, and prints a per-file verdict plus a final count.
// Usage: npm test   (or)   node tests/run-all.mjs
// Exit 0 when every file exits 0, exit 1 otherwise. No test framework.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const SELF = fileURLToPath(import.meta.url);

function collect() {
  return readdirSync(HERE)
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => join(HERE, name))
    .filter((abs) => abs !== SELF)
    .sort();
}

function displayPath(abs) {
  return relative(REPO_ROOT, abs).split(sep).join("/");
}

const files = collect();

if (files.length === 0) {
  console.log("FAIL no test files matched tests/*.test.mjs");
  console.log("0/0 files passed");
  process.exit(1);
}

let passed = 0;
const failed = [];

for (const abs of files) {
  const label = displayPath(abs);
  const child = spawnSync(process.execPath, [abs], { stdio: "inherit" });
  const ok = child.status === 0 && child.error === undefined;
  if (ok) {
    passed += 1;
    console.log(`PASS ${label}`);
  } else {
    failed.push(label);
    const reason = child.error ? String(child.error.message) : `exit ${child.status}`;
    console.log(`FAIL ${label} (${reason})`);
  }
}

console.log("");
console.log(`${passed}/${files.length} files passed`);
if (failed.length > 0) {
  console.log(`failed files: ${failed.join(", ")}`);
  process.exit(1);
}
process.exit(0);
