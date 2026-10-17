#!/usr/bin/env node
// Live smoke matrix for the deployed Blip agent.
// Usage: node tests/live-matrix.mjs
// Reads AGENT_API_KEY from ../.dev.vars, POSTs 4 probes to the worker,
// prints status / reply preview / tools / state / PASS-FAIL per probe.
// Exit code 0 only when all four probes PASS.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const URL_ENDPOINT = "https://agent-federation.agent-federation.workers.dev/api/message";
const TIMEOUT_MS = 120_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_VARS = join(HERE, "..", ".dev.vars");

function readApiKey() {
  let raw;
  try {
    raw = readFileSync(DEV_VARS, "utf8");
  } catch (err) {
    console.error(`FATAL: cannot read ${DEV_VARS}: ${err.message}`);
    process.exit(2);
  }
  const m = raw.match(/AGENT_API_KEY=([a-f0-9]+)/);
  if (!m) {
    console.error(`FATAL: AGENT_API_KEY=([a-f0-9]+) not found in ${DEV_VARS}`);
    process.exit(2);
  }
  return m[1];
}

const CASES = [
  {
    id: 1,
    label: "ping",
    body: { content: "say pong" },
    check(env) {
      const reply = env.reply ?? "";
      return /pong/i.test(reply);
    },
    why: "reply contains 'pong' (case-insensitive)",
  },
  {
    id: 2,
    label: "deterministic tool run",
    body: { content: "run: echo blip-can-run" },
    check(env) {
      const t0 = Array.isArray(env.tools) ? env.tools[0] : null;
      const cmd = String((t0 && t0.cmd) || "");
      const out = String((t0 && t0.output) || "");
      return cmd.includes("echo blip-can-run") && out.includes("blip-can-run");
    },
    why: "tools[0].cmd includes 'echo blip-can-run' AND output includes 'blip-can-run'",
  },
  {
    id: 3,
    label: "capabilities",
    body: { content: "what can you do" },
    check(env) {
      return String(env.reply ?? "").toLowerCase().includes("sandbox");
    },
    why: "reply mentions 'sandbox'",
  },
  {
    id: 4,
    label: "freeform generation",
    body: { content: "write a 2-line poem about butterflies" },
    check(env) {
      const reply = String(env.reply ?? "");
      return reply.trim().length > 0 && !reply.includes("[error]");
    },
    why: "reply non-empty and no '[error]'",
  },
];

async function runCase(kase, apiKey) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let status = 0;
  let envelope = null;
  let netError = null;
  try {
    const res = await fetch(URL_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(kase.body),
      signal: ctl.signal,
    });
    status = res.status;
    const text = await res.text();
    try {
      envelope = JSON.parse(text);
    } catch {
      envelope = { reply: text, parseError: true };
    }
  } catch (err) {
    netError = err && err.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : String(err && err.message ? err.message : err);
  } finally {
    clearTimeout(timer);
  }
  const ms = Date.now() - started;

  const reply = String((envelope && envelope.reply) || "");
  const tools = Array.isArray(envelope && envelope.tools) ? envelope.tools : [];
  const state = envelope && envelope.state != null ? String(envelope.state) : "-";
  const preview = reply.slice(0, 200).replace(/\r?\n/g, "\\n");

  const httpOk = status === 200;
  const passed = httpOk && netError === null && kase.check(envelope || {});

  console.log(`--- [${kase.id}] ${kase.label} ---`);
  console.log(`  body     : ${JSON.stringify(kase.body)}`);
  console.log(`  status   : ${httpOk ? 200 : status}${netError ? ` (network: ${netError})` : ""}  (${ms}ms)`);
  console.log(`  reply[0..200]: ${preview}`);
  console.log(`  tools    : ${tools.length}`);
  console.log(`  state    : ${state}`);
  console.log(`  criteria : ${kase.why}`);
  console.log(`  result   : ${passed ? "PASS" : "FAIL"}`);
  console.log("");
  return passed;
}

const apiKey = readApiKey();
console.log(`live-matrix -> ${URL_ENDPOINT}`);
console.log(`key         : ${apiKey.slice(0, 4)}...${apiKey.slice(-4)} (${apiKey.length} chars)`);
console.log(`timeout     : ${TIMEOUT_MS}ms per probe\n`);

let allPass = true;
for (const kase of CASES) {
  const ok = await runCase(kase, apiKey);
  if (!ok) allPass = false;
}

console.log(allPass ? "OVERALL: PASS (4/4)" : "OVERALL: FAIL");
process.exit(allPass ? 0 : 1);
