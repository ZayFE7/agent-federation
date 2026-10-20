// Unit tests for src/harness-config.ts: OUR options object, not the SDK's
// behaviour. The seam exists so `Env` and zod stay out of this path and the
// assertions are about the numbers and shapes this plan rules on.
// Plain Node: `node tests/harness.test.mjs`. Silent on success (exit 0).

import assert from "node:assert/strict";
import {
  harnessConfig,
  MAX_STEPS_CHAT,
  MAX_STEPS_DEEP,
  RECOVERY,
  COMPACT_AFTER_TOKENS,
} from "../src/harness-config.ts";
import { DEFAULT_PERSONA } from "../src/capabilities.ts";

const failures = [];

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

const classifyError = (e) => ({ kind: "other", error: e });
const seenSessions = [];
const deps = {
  env: { ROUTER_URL: "", ROUTER_KEY: "test-key", MODEL_PRIMARY: "test-model" },
  tools: (session) => {
    seenSessions.push(session);
    return {};
  },
  maxSteps: MAX_STEPS_CHAT,
  classifyError,
  onEvent: () => {},
  onTurnEnd: async () => {},
  summarize: async (text) => text,
};

const config = harnessConfig(deps);

check("the one budget is 12, and the deep budget is declared but not wired", () => {
  assert.equal(MAX_STEPS_CHAT, 12);
  assert.equal(MAX_STEPS_DEEP, 45);
});

check("maxSteps is the construction-time number this ruling requires", () => {
  assert.equal(config.maxSteps, 12);
  assert.equal(typeof config.maxSteps, "number", "a PerSession function is the bug R70 bans");
});

check("model and system are PerSession functions, not frozen values", () => {
  assert.equal(typeof config.model, "function");
  assert.equal(typeof config.system, "function");
  assert.equal(config.system({ session: "s1" }), DEFAULT_PERSONA);
});

check("tools is a factory so each session binds its own sandbox lease (R40)", () => {
  assert.equal(typeof config.tools, "function");
  assert.deepEqual(config.tools({ session: "s1" }), {});
  assert.deepEqual(seenSessions, ["s1"]);
});

check("toolApproval ORs in needsApproval with all four keys present", () => {
  const verdict = config.toolApproval({
    session: "s1",
    toolName: "exec",
    toolCallId: "tc1",
    input: { cmd: "rm -rf /" },
  });
  assert.equal(verdict, true);
  assert.equal(
    config.toolApproval({
      session: "s1",
      toolName: "exec",
      toolCallId: "tc2",
      input: { cmd: "ls -la" },
    }),
    false
  );
});

check("classifyError is the injected function, not a wrapper", () => {
  assert.equal(config.hooks.classifyError, classifyError);
});

check("no invented hooks.onEvent: events belong to harness.observe()", () => {
  assert.equal("onEvent" in config.hooks, false);
  assert.equal(config.hooks.onEvent, undefined);
});

check("recovery carries the three explicit numbers", () => {
  assert.deepEqual(config.recovery, {
    maxAttempts: 2,
    backoffMs: 1_000,
    stallTimeoutMs: 120_000,
  });
  assert.deepEqual(RECOVERY, config.recovery);
});

check("configureSession registers compaction synchronously at the threshold", () => {
  let hook = null;
  let threshold = null;
  const session = {
    onCompaction(fn) {
      hook = fn;
      return {
        compactAfter(tokens) {
          threshold = tokens;
        },
      };
    },
  };
  const returned = config.configureSession(session, "s1");
  assert.equal(returned, undefined, "configureSession is sync and returns void");
  assert.equal(typeof hook, "function");
  assert.equal(threshold, COMPACT_AFTER_TOKENS);
  assert.equal(COMPACT_AFTER_TOKENS, 80_000);
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`harness: ${failures.length} failed`);
  process.exit(1);
}
