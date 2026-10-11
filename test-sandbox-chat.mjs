import { writeFileSync } from "node:fs";
writeFileSync(
  "E:/Users/Zay L/agent-federation/tc.json",
  JSON.stringify({
    content:
      "Use your sandbox to run: date, then python3 -c 'print(6*7)'. Show me the outputs.",
    tier: "primary",
  })
);
console.log("written");
