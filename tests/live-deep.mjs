#!/usr/bin/env node
// Deep live matrix for deployed BLIP: guardrail hold+approve, memory recall,
// plan decomposition. Reads key from .dev.vars. Retries model round-trips that
// hit the 25s router-timeout, since the quick-tunnel is intermittent.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = "https://agent-federation.agent-federation.workers.dev";
const HERE = dirname(fileURLToPath(import.meta.url));
const DEV = join(HERE, "..", ".dev.vars");
const KEY = readFileSync(DEV, "utf8").match(/AGENT_API_KEY=([a-f0-9]+)/)[1];

const timeoutReply = (o) =>
  o && typeof o.reply === "string" && /timed out|no route|unreachable/i.test(o.reply);

async function msg(content, tries = 5) {
  for (let i = 1; i <= tries; i++) {
    const t0 = Date.now();
    let o;
    try {
      const r = await fetch(BASE + "/api/message", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ content, tier: "primary" }),
        signal: AbortSignal.timeout(60_000),
      });
      o = await r.json();
    } catch (e) {
      o = { reply: "network " + e.name, state: "error" };
    }
    const ms = Date.now() - t0;
    if (!timeoutReply(o)) return { o, ms, tries: i };
    process.stdout.write(`      (retry ${i}: timed out in ${ms}ms)\n`);
  }
  return { o, ms: -1, tries };
}
const getJSON = (p, opts) =>
  fetch(BASE + p, { headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, ...opts }).then((r) => r.json());

const S = (x) => JSON.stringify(x);

// ---- Test 1: guardrail hold + approve ----
console.log("=== [1] guardrail hold + approve ===");
let g = await msg("Use your exec tool to run exactly this shell command: rm -rf /home/user/scratchpad");
console.log(`  msg ${g.ms}ms tries=${g.tries} state=${g.o.state} pending=${S(g.o.pending || null)}`);
let plan = await getJSON("/api/plan");
let held = plan.pending;
// keep nudging if the router timed out before it could hold
for (let i = 0; !held && i < 3; i++) {
  g = await msg("Run the shell command rm -rf /home/user/scratchpad using exec");
  plan = await getJSON("/api/plan");
  held = plan.pending;
}
if (!held) {
  console.log("  RESULT: FAIL (could not trigger a hold; model did not emit a risky exec)");
} else {
  console.log(`  HELD #${held.id}: ${held.cmd} (status=${held.status})`);
  const ap = await getJSON("/api/approve", { method: "POST", body: JSON.stringify({ id: held.id, approve: true }) });
  console.log(`  approve -> ok=${ap.ok} state=${ap.state} output=${S(String(ap.output || "").slice(0, 120))}`);
  console.log(`  RESULT: ${held.status === "held" && ap.ok ? "PASS" : "PARTIAL"}`);
}

// ---- Test 2: memory store + recall across turns ----
console.log("\n=== [2] memory store + recall ===");
const fact = "my rare pet iguana is named Zzyzx-9000";
let m1 = await msg(`Remember this fact about me: ${fact}. Just acknowledge briefly.`);
console.log(`  store ${m1.ms}ms: ${S(String(m1.o.reply || "").slice(0, 120))}`);
let m2 = await msg("What is the name of my rare pet iguana? Answer with just the name.");
console.log(`  recall ${m2.ms}ms: ${S(String(m2.o.reply || "").slice(0, 160))}`);
const recalled = /Zzyzx-9000/i.test(String(m2.o.reply || ""));
console.log(`  RESULT: ${recalled ? "PASS (name recalled)" : "FAIL (name not recalled)"} `);

// ---- Test 3: plan decomposition ----
console.log("\n=== [3] plan decomposition ===");
let p = await msg("Use your plan tool to make a 4-step plan for building a CLI markdown-to-HTML converter.");
console.log(`  msg ${p.ms}ms state=${p.o.state} plan-in-reply=${Array.isArray(p.o.plan) ? p.o.plan.length : 0}`);
let pl = await getJSON("/api/plan");
console.log(`  /api/plan -> ${pl.plan.length} step(s): ${pl.plan.map((x) => `(${x.ord},${x.status})`).join(" ")}`);
if (pl.plan.length) console.log(`  step1: ${S(String(pl.plan[0].title).slice(0, 80))}`);
console.log(`  RESULT: ${pl.plan.length >= 2 ? "PASS" : "FAIL"}`);

console.log("\nOVERALL deep-matrix finished.");
