import fs from "node:fs";
const cfg = JSON.parse(fs.readFileSync("E:/Users/Zay L/agent-federation/deploy/router-worker/router-config.json", "utf8"));
const oc = cfg.connections.find((x) => x.provider === "opencode");
const ses = oc.extraHeaders["x-opencode-session"];
console.log("using session:", ses);

const fp = ["bash", "glob", "grep", "read"].map((name) => ({
  type: "function",
  function: { name, description: "This tool is currently unavailable and must not be used.", parameters: { type: "object", properties: {} } },
}));
const hex = [...crypto.getRandomValues(new Uint8Array(6))].map((x) => x.toString(16).padStart(2, "0")).join("");
const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const tail = [...crypto.getRandomValues(new Uint8Array(14))].map((x) => chars[x % chars.length]).join("");

const c = await fetch("https://opencode.ai/zen/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer public",
    "User-Agent": "opencode/1.18.31",
    "x-opencode-client": "desktop",
    "x-opencode-session": ses,
    "x-opencode-request": `msg_${hex}${tail}`,
    "x-opencode-project": "global",
    Accept: "text/event-stream",
  },
  body: JSON.stringify({
    model: "mimo-v2.6-flash-free",
    messages: [{ role: "user", content: "say ok" }],
    max_tokens: 32,
    stream: true,
    tools: fp,
    tool_choice: "none",
  }),
});
console.log("direct status:", c.status);
const t = await c.text();
console.log(t.slice(0, 350));
