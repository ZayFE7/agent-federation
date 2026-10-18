#!/usr/bin/env node
// Live smoke matrix for the deployed Blip agent.
// Usage: point BLIP_URL at the origin you deployed, put a real key in .dev.vars,
// then run: node tests/live-matrix.mjs
// Reads AGENT_API_KEY from ../.dev.vars, POSTs 4 probes to the worker,
// prints status / reply preview / tools / state / PASS-FAIL per probe.
// Exit code 0 only when all four probes PASS, 1 on any FAIL, 2 on setup errors.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TIMEOUT_MS = 120_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_VARS = join(HERE, "..", ".dev.vars");

// No default host, on purpose: with a fallback this script tests somebody
// else's deployment instead of yours and prints PASS for work you did not ship.
const BASE = process.env.BLIP_URL;
if (!BASE) {
  console.error("FATAL: BLIP_URL is not set. set BLIP_URL to the origin of the");
  console.error("worker you deployed (scheme + host only, no path), for example:");
  console.error('  cmd:  set BLIP_URL=<your origin> then run this file again');
  console.error('  sh:   export BLIP_URL="<your origin>"');
  process.exit(2);
}
const URL_ENDPOINT = `${BASE.replace(/\/+$/, "")}/api/message`;

const PLACEHOLDER_RE = /^(generate-me|change-me|replace-me|your[-_]?key[-_]?here|todo|xxx+)$/i;

function readApiKey() {
  let raw;
  try {
    raw = readFileSync(DEV_VARS, "utf8");
  } catch (err) {
    console.error(`FATAL: cannot read ${DEV_VARS}: ${err.message}`);
    process.exit(2);
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^AGENT_API_KEY=(.+)$/);
    if (!m) continue;
    const value = m[1].trim().replace(/^["']|["']$/g, "");
    if (PLACEHOLDER_RE.test(value)) {
      console.error(
        `FATAL: AGENT_API_KEY in ${DEV_VARS} is still the placeholder "${value}".`
      );
      console.error("Set a real key there (and as a secret on the worker) and re-run.");
      process.exit(2);
    }
    return value;
  }
  console.error(`FATAL: no AGENT_API_KEY= line found in ${DEV_VARS}. Set a real key there.`);
  process.exit(2);
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
console.log(`key         : redacted (${apiKey.length} chars read from .dev.vars)`);
console.log(`timeout     : ${TIMEOUT_MS}ms per probe\n`);

let allPass = true;
for (const kase of CASES) {
  const ok = await runCase(kase, apiKey);
  if (!ok) allPass = false;
}

console.log(allPass ? "OVERALL: PASS (4/4)" : "OVERALL: FAIL");
process.exit(allPass ? 0 : 1);
