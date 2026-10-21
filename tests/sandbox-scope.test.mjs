// Contract tests for deploy/sandbox-worker/pool.ts and the wiring that uses it
// (plan Task 28). Two kinds of check, because the worker's own entry module
// value-imports `e2b` and so cannot be loaded by Node offline: the eviction
// policy is tested as real code, and the wiring that has to agree with it is
// tested as source text.
//
// Why a cap at all. Every fresh session boot creates one E2B microVM, the VM
// lives until its lease expires, and nothing in the code path between those two
// facts limits how many exist. One chat building six files in six new sessions
// quietly asks for six VMs. `pickEviction` is the whole policy: above the cap,
// kill the least recently used, and never the session that just asked.
//
// Why recency is read off the lease rather than counted in a table. A busy
// session's lease is extended on every request, so `endAt - LEASE_MS` is its
// last-touch time, and the live set is whatever the sandbox API says is running.
// A per-isolate Map would lie (Workers give no guarantee of one isolate), and a
// KV index of live sessions would need a list() per request, which the free plan
// rations to 1,000 a day.
//
// The TTL in the second half of B used to be 600 s against a 300 s lease: the KV
// row outlived the VM, so the first request after five idle minutes connected to
// a corpse, threw, deleted its own row and cold-booted. The pin here is that the
// row now expires no later than the VM it points at.
//
// Plain Node, no framework, no build step: run with `node tests/sandbox-scope.test.mjs`.
// Silent on success (exit 0). Prints every failure and exits 1 otherwise.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  LEASE_MS,
  MAX_LIVE_SANDBOXES,
  POOL_APP_KEY,
  POOL_APP_VALUE,
  POOL_SESSION_KEY,
  POOL_TTL_SECONDS,
  pickEviction,
  toLive,
} from "../deploy/sandbox-worker/pool.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const poolSrc = readFileSync(join(root, "deploy", "sandbox-worker", "pool.ts"), "utf8");
const workerSrc = readFileSync(join(root, "deploy", "sandbox-worker", "src", "index.ts"), "utf8");
const agentSrc = readFileSync(join(root, "src", "agent.ts"), "utf8");

const failures = [];

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

const live = (sessionId, lastUsed) => ({ sessionId, lastUsed });

// ------------------------------------------------------------- policy shape ----

check("the cap is four live sandboxes, and the lease is the plan's 300 s", () => {
  assert.equal(MAX_LIVE_SANDBOXES, 4);
  assert.equal(LEASE_MS, 300_000);
});

check("the KV pool row expires no later than the VM it points at", () => {
  assert.ok(POOL_TTL_SECONDS * 1000 <= LEASE_MS, `${POOL_TTL_SECONDS}s outlives ${LEASE_MS / 1000}s`);
  assert.ok(POOL_TTL_SECONDS >= 60, "KV minimum expirationTtl is 60 seconds");
});

check("pool.ts stays import-free so the sandbox tree mirrors it as one file", () => {
  assert.doesNotMatch(poolSrc, /^\s*import\s/m);
  assert.doesNotMatch(poolSrc, /\brequire\(/);
});

// ------------------------------------------------------------ pickEviction ----

check("under the cap nothing is evicted", () => {
  assert.equal(pickEviction([], "req"), null);
  assert.equal(pickEviction([live("a", 1), live("b", 2)], "req"), null);
  assert.equal(pickEviction([live("a", 1), live("b", 2), live("c", 3)], "req"), null);
});

check("at the cap the oldest is evicted to make room", () => {
  const rows = [live("a", 100), live("b", 300), live("c", 200), live("d", 400)];
  assert.equal(pickEviction(rows, "new"), "a");
});

check("the session that just asked is never the eviction, even when oldest", () => {
  const rows = [live("a", 1), live("b", 50), live("c", 60), live("d", 70)];
  assert.equal(pickEviction(rows, "a"), "b");
});

check("a table of only the requesting session evicts nothing", () => {
  assert.equal(pickEviction([live("a", 1)], "a"), null);
  assert.equal(
    pickEviction([live("a", 1), live("a", 2), live("a", 3), live("a", 4)], "a"),
    null
  );
});

check("the cap counts distinct sessions, not rows", () => {
  // Three rows but two live sandboxes: no room needed, so no eviction.
  assert.equal(pickEviction([live("a", 1), live("a", 9), live("b", 2)], "c"), null);
});

check("equal lastUsed breaks toward the lexicographically smaller id", () => {
  const rows = [live("zeta", 5), live("alpha", 5), live("mid", 5), live("other", 5)];
  assert.equal(pickEviction(rows, "new"), "alpha");
});

check("over the cap by more than one evicts one per call", () => {
  const rows = [live("a", 1), live("b", 2), live("c", 3), live("d", 4), live("e", 5)];
  assert.equal(pickEviction(rows, "new"), "a");
});

check("pickEviction does not mutate or reorder its input", () => {
  const rows = [live("a", 10), live("b", 1), live("c", 5)];
  const before = JSON.stringify(rows);
  pickEviction(rows, "z");
  assert.equal(JSON.stringify(rows), before);
});

check("a non-positive or non-finite lastUsed sorts as oldest, never crashes", () => {
  assert.equal(pickEviction([live("a", NaN), live("b", 5), live("c", 6), live("d", 7)], "z"), "a");
});

// ------------------------------------------------------------------- toLive ----

const row = (session, endAtMs, state = "running") => ({
  sandboxId: `sbx-${session}`,
  state,
  endAt: new Date(endAtMs),
  metadata: session === null ? {} : { [POOL_APP_KEY]: POOL_APP_VALUE, [POOL_SESSION_KEY]: session },
});

check("toLive maps endAt minus one lease onto lastUsed", () => {
  const end = 1_000_000;
  const [one] = toLive([row("a", end)]);
  assert.equal(one.sessionId, "a");
  assert.equal(one.lastUsed, end - LEASE_MS);
});

check("toLive keeps only rows carrying this app's pool tag", () => {
  const out = toLive([row("a", 1_000_000), row(null, 2_000_000)]);
  assert.deepEqual(out.map((r) => r.sessionId), ["a"]);
});

check("toLive keeps paused VMs, because they still hold quota", () => {
  const out = toLive([row("a", 1_000_000, "paused")]);
  assert.equal(out.length, 1);
});

check("toLive tolerates a missing endAt rather than making NaN recency", () => {
  const bad = [{ sandboxId: "x", state: "running", metadata: { [POOL_SESSION_KEY]: "a" } }];
  assert.deepEqual(toLive(bad), []);
});

check("toLive accepts rows with no metadata object at all", () => {
  assert.deepEqual(toLive([{ sandboxId: "x", state: "running", endAt: new Date(1) }]), []);
});

// ------------------------------------------------------- wiring, as text ----

check("the worker imports its pool policy instead of restating it", () => {
  assert.match(workerSrc, /from "\.\.\/pool"/);
  assert.doesNotMatch(workerSrc, /const POOL_TTL\b|const BOOT_TIMEOUT_MS\b/);
});

check("no route defaults a caller's session to the old fixed bucket", () => {
  assert.doesNotMatch(workerSrc, /\|\|\s*"agent"/);
});

check("created sandboxes carry the pool tag the list is filtered by", () => {
  const create = workerSrc.slice(workerSrc.indexOf("async function createSandbox"));
  assert.match(create.slice(0, 900), /\[POOL_APP_KEY\]:\s*POOL_APP_VALUE/);
  assert.match(create.slice(0, 900), /\[POOL_SESSION_KEY\]:\s*sessionId/);
  assert.match(create.slice(0, 900), /timeoutMs:\s*LEASE_MS/);
});

check("the eviction path calls the worker's own kill, not a comment about it", () => {
  assert.match(workerSrc, /Sandbox\.kill\(/);
});

check("an eviction saves the victim's files before it destroys its VM", () => {
  const start = workerSrc.indexOf("async function makeRoom");
  assert.ok(start > -1, "makeRoom is gone");
  const body = workerSrc.slice(start, start + 2400);
  const saved = body.indexOf("snapshot(");
  const killed = body.indexOf("kill(");
  assert.ok(saved > -1 && killed > -1, "both a save and a kill must be in the path");
  assert.ok(saved < killed, "the kill must come after the save");
});

check("a pool read that fails cannot 502 the request that triggered it", () => {
  const start = workerSrc.indexOf("async function makeRoom");
  const body = workerSrc.slice(start, start + 2400);
  assert.match(body, /catch/);
  assert.match(body, /return null/);
});

check("a reused sandbox has its lease extended, which is what makes recency real", () => {
  assert.match(workerSrc, /\.setTimeout\(/);
});

check("the bearer gate is still the fail-closed helper, not a plain comparison", () => {
  assert.match(workerSrc, /authed\(/);
  assert.doesNotMatch(workerSrc, /got\s*!==\s*env\.SBOX_TOKEN|env\.SBOX_TOKEN\s*!==\s*got/);
});

check("the agent passes its own session id to the sandbox, never a fixed one", () => {
  assert.doesNotMatch(agentSrc, /sessionId:\s*"agent"/);
  assert.doesNotMatch(agentSrc, /\bsessionId:\s*"main"/);
  const run = agentSrc.slice(agentSrc.indexOf('https://zay-sandbox/run'));
  assert.match(run.slice(0, 700), /body:\s*JSON\.stringify\(\{\s*cmd,\s*sessionId\s*\}\)/);
  const snap = agentSrc.slice(agentSrc.indexOf("/workspace/snapshot"));
  assert.match(snap.slice(0, 700), /body:\s*JSON\.stringify\(\{\s*sessionId:\s*session\s*\}\)/);
});

if (failures.length) {
  process.stdout.write(`sandbox-scope: ${failures.length} failure(s)\n`);
  for (const f of failures) process.stdout.write(`FAIL ${f}\n`);
  process.exit(1);
}
