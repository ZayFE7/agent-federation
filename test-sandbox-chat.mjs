import { writeFileSync, readFileSync } from "node:fs";
const raw = readFileSync("E:/Users/Zay L/agent-federation/.dev.vars", "utf8");
const ak = raw.match(/AGENT_API_KEY=([a-f0-9]+)/)[1];
writeFileSync(
  "E:/Users/Zay L/agent-federation/tc.json",
  JSON.stringify({
    content:
      "Schedule a daily job at 08:00 UTC: run date in the sandbox and save a one-line log to /workspace/daily.log",
    tier: "cheap",
  })
);
console.log("body written, key len", ak.length);
