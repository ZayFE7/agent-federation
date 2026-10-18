#!/usr/bin/env node
// Close the last two tools: plan_done (mark a step) and save_workspace.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const BASE = "https://agent-federation.agent-federation.workers.dev";
const KEY = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars"), "utf8")
  .match(/AGENT_API_KEY=([a-f0-9]+)/)[1];
const H = { "content-type": "application/json", authorization: `Bearer ${KEY}` };
const timeout = (o) => /timed out|no route|unreachable/i.test(String(o && o.reply));
async function msg(c, tries = 5) {
  let o;
  for (let i = 1; i <= tries; i++) {
    const t = Date.now();
    o = await fetch(BASE + "/api/message", { method: "POST", headers: H, body: JSON.stringify({ content: c, tier: "primary" }), signal: AbortSignal.timeout(60_000) }).then((r) => r.json()).catch((e) => ({ reply: "net " + e.name, state: "error" }));
    if (!timeout(o)) return { o, ms: Date.now() - t, i };
  }
  return { o, ms: -1, i: tries };
}
const plan = () => fetch(BASE + "/api/plan", { headers: H }).then((r) => r.json());
const S = (x) => JSON.stringify(x);

console.log("=== plan: current steps ===");
let p = await plan();
console.log("  " + p.plan.map((x) => `${x.ord}:${x.status}`).join("  "));

console.log("\n=== [4] plan_done (mark step 1) ===");
let d = await msg("Mark step 1 of the current plan as done using the plan_done tool.");
console.log(`  msg ${d.ms}ms tries=${d.i} state=${d.o.state}`);
console.log(`  reply: ${S(String(d.o.reply || "").slice(0, 160))}`);
p = await plan();
console.log("  steps now: " + p.plan.map((x) => `${x.ord}:${x.status}`).join("  "));
console.log(`  RESULT: ${p.plan.some((x) => x.ord === 1 && x.status === "done") ? "PASS" : "FAIL/timeout"}`);

console.log("\n=== [5] save_workspace ===");
let w = await msg("Use the save_workspace tool to snapshot your working files now.");
console.log(`  msg ${w.ms}ms tries=${w.i} state=${w.o.state}`);
console.log(`  tools: ${S((w.o.tools || []).map((t) => ({ name: t.name, ok: t.ok, out: String(t.output || "").slice(0, 160) })))}`);
console.log(`  reply: ${S(String(w.o.reply || "").slice(0, 220))}`);
