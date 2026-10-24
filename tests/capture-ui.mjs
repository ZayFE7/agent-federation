#!/usr/bin/env node
// Capture every console screen at desktop, tablet and phone widths, in both
// themes, with synthetic widget states that never touch the agent.
//
//   node tests/capture-ui.mjs --out ../context/audits/ui-polish/before
//   node tests/capture-ui.mjs --url https://example.workers.dev --out shots
//
// No dependencies. Launches the Chrome already on this machine and speaks CDP
// over its WebSocket. Reads the agent key from agent_key.local, writes it into
// the throwaway browser profile only, and never prints it. The synthetic turn
// calls the console's own mount functions in the page; it sends no request and
// creates no session.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const URL_BASE = String(flag("url", "https://agent-federation.agent-federation.workers.dev"));
const OUT = resolve(ROOT, String(flag("out", "../context/audits/ui-polish/capture")));
const KEY_FILE = join(ROOT, "agent_key.local");
const KEY = existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : "";

const CHROMES = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const chrome = CHROMES.find((p) => existsSync(p));
if (!chrome) {
  console.error("No Chrome or Edge found. Set CHROME=/path/to/chrome.");
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) {
  if (/\.png$/.test(f)) rmSync(join(OUT, f));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = join(tmpdir(), "blip-capture-" + Date.now());
mkdirSync(profile, { recursive: true });
const proc = spawn(
  chrome,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--font-render-hinting=none",
    "about:blank",
  ],
  { stdio: "ignore" }
);

async function wsEndpoint() {
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 200; i++) {
    if (existsSync(portFile)) {
      let raw = "";
      try {
        raw = readFileSync(portFile, "utf8");
      } catch {
        // Chrome holds the file briefly on Windows.
      }
      const [port] = raw.split("\n");
      if (port) {
        try {
          const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
          return v.webSocketDebuggerUrl;
        } catch {
          // Not listening yet.
        }
      }
    }
    await sleep(50);
  }
  throw new Error("Chrome did not expose a DevTools port");
}

class Conn {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Set();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { ok, fail } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? fail(new Error(msg.error.message)) : ok(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers) h(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  on(fn) {
    this.handlers.add(fn);
  }
}

let ws;
let conn;
let sessionId;
const problems = [];
const manifest = [];

async function evaluate(expression, awaitPromise = true) {
  const { result, exceptionDetails } = await conn.send(
    "Runtime.evaluate",
    { expression, awaitPromise, returnByValue: true, userGesture: true },
    sessionId
  );
  if (exceptionDetails) {
    const text =
      exceptionDetails.exception?.description ||
      exceptionDetails.text ||
      "page evaluation failed";
    throw new Error(text.split("\n")[0]);
  }
  return result?.value;
}

async function waitFor(expression, timeout = 12000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    try {
      last = await evaluate(`(() => { try { return !!(${expression}); } catch (e) { return false; } })()`, false);
      if (last) return true;
    } catch {
      // The page may be mid-reload.
    }
    await sleep(150);
  }
  return false;
}

async function viewport(width, height, mobile) {
  await conn.send(
    "Emulation.setDeviceMetricsOverride",
    {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: !!mobile,
      screenWidth: width,
      screenHeight: height,
    },
    sessionId
  );
  await sleep(350);
}

async function reload(waitForSelector = "#app") {
  await conn.send("Page.reload", { ignoreCache: false }, sessionId);
  await sleep(700);
  await waitFor(`document.querySelector(${JSON.stringify(waitForSelector)})`, 12000);
  await sleep(900);
}

async function shot(name) {
  const { data } = await conn.send(
    "Page.captureScreenshot",
    { format: "png", fromSurface: true, captureBeyondViewport: false },
    sessionId
  );
  const path = join(OUT, name + ".png");
  writeFileSync(path, Buffer.from(data, "base64"));
  manifest.push(name + ".png");
  console.log("  " + name + ".png");
}

async function theme(name) {
  await evaluate(
    `D.dataset.theme=${JSON.stringify(name)}; if (typeof syncTheme === "function") syncTheme(); if (typeof upd === "function") upd(); true`,
    false
  );
  await sleep(350);
}

async function openFirstSession() {
  const ok = await waitFor(
    `typeof state !== "undefined" && Array.isArray(state.sessions) && state.sessions.length > 0`,
    15000
  );
  if (!ok) return false;
  await evaluate(
    `(async () => { const id = state.sessions[0].id; await openSession(id); await new Promise(r => setTimeout(r, 1000)); return true; })()`
  );
  await sleep(700);
  return true;
}

async function go(tab) {
  await evaluate(`go(${JSON.stringify(tab)}); true`, false);
  await sleep(900);
}

async function syntheticTurn(options = {}) {
  const dark = options.dark ? "dark" : "light";
  const sid = await evaluate(`(state.sessions[0] && state.sessions[0].id) || "main"`, false);
  await evaluate(
    `(() => {
      teardown(); PENDING = null; busy = false; cur = "idle"; LIVE = null;
      const now = Date.now();
      LOG = [
        ["u", "Check the saved workspace, search for the Agent SDK release notes, and show me the result.", now - 60000],
        ["a", "I'll list the workspace first, then search. I'll stop if a command needs your approval.", now - 55000]
      ];
      tab = "chat";
      NF = 99;
      renderThread();
      if (typeof render === "function") render();
      beginLive(${JSON.stringify(sid)});
      mountTool({t:"tool-start", id:"cap-a", name:"exec", label:"Shell", state:"code", input:JSON.stringify({cmd:"ls -la /home/user/project"})});
      updateTool({t:"tool-progress", id:"cap-a", phase:"running", message:"Running command", fraction:null, tail:""});
      settleTool({t:"tool-result", id:"cap-a", name:"exec", ok:true, output:"exit 0 (success)\\nstdout:\\napp  package.json  src  tests\\n\\nstderr:\\n"});
      mountTool({t:"tool-start", id:"cap-b", name:"lookup_online", label:"Search", state:"search", input:JSON.stringify({query:"Cloudflare Agents SDK release notes"})});
      updateTool({t:"tool-progress", id:"cap-b", phase:"running", message:"Searching the web", fraction:null});
      settleTool({t:"tool-result", id:"cap-b", name:"lookup_online", ok:true, output:"5 results from the last 30 days. The latest release adds durable streams."});
      mountTool({t:"tool-start", id:"cap-c", name:"exec", label:"Shell", state:"code", input:JSON.stringify({cmd:"ls /definitely-not-here"})});
      settleTool({t:"tool-result", id:"cap-c", name:"exec", ok:false, output:"exit 2 (failed)\\nstderr:\\nls: cannot access '/definitely-not-here': No such file or directory"});
      mountTool({t:"tool-start", id:"cap-d", name:"exec", label:"Shell", state:"code", input:JSON.stringify({cmd:"python3 -c \\"print('rotate the token')\\""})});
      mountGate({t:"approval", id:"cap-e", toolCallId:"cap-d", label:"Shell", cmd:"python3 -c \\"print('rotate the token')\\""});
      cur = "approve";
      if (typeof upd === "function") upd();
      return true;
    })()`
  );
  await sleep(900);
  await theme(dark);
  await shot(options.name || "chat-widgets");
}

async function main() {
  const endpoint = await wsEndpoint();
  ws = new WebSocket(endpoint);
  await new Promise((ok, fail) => {
    ws.addEventListener("open", ok, { once: true });
    ws.addEventListener("error", fail, { once: true });
  });
  conn = new Conn(ws);

  const { targetId } = await conn.send("Target.createTarget", { url: "about:blank" });
  ({ sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true }));

  conn.on((msg) => {
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      problems.push("exception: " + (d.exception?.description || d.text));
    }
    if (
      msg.method === "Runtime.consoleAPICalled" &&
      (msg.params.type === "error" || msg.params.type === "assert")
    ) {
      const text = msg.params.args
        .map((a) => a.value ?? a.description ?? a.unserializableValue ?? "")
        .join(" ");
      problems.push(msg.params.type + ": " + text);
    }
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      const t = msg.params.entry.text || "";
      if (!/favicon|fonts\.gstatic|fonts\.googleapis/.test(t)) problems.push("log: " + t);
    }
  });

  await conn.send("Page.enable", {}, sessionId);
  await conn.send("Runtime.enable", {}, sessionId);
  await conn.send("Log.enable", {}, sessionId);

  await viewport(1440, 900, false);
  await conn.send("Page.navigate", { url: URL_BASE + "/?capture=1" }, sessionId);
  await sleep(1600);

  console.log("desktop 1440x900");
  await shot("desktop-connect");

  if (!KEY) {
    console.error("agent_key.local is missing, so the authenticated screens were skipped.");
    await finish(2);
    return;
  }
  await evaluate(
    `localStorage.setItem("blip_key", ${JSON.stringify(KEY)}); localStorage.removeItem("blip.theme"); true`,
    false
  );
  await reload();
  await theme("light");
  await go("chat");
  await openFirstSession();
  await shot("desktop-chat-history");

  await evaluate(`LOG = []; renderThread(); cur = "idle"; upd(); true`, false);
  await sleep(400);
  await shot("desktop-chat-empty");

  await syntheticTurn({ name: "desktop-chat-widgets-light" });
  await syntheticTurn({ name: "desktop-chat-widgets-dark", dark: true });

  await evaluate(
    `teardown(); PENDING = null; busy = false; cur = "idle"; LOG = []; renderThread(); render(); true`,
    false
  );
  await sleep(350);

  await theme("light");
  await go("tasks");
  await shot("desktop-tasks");
  await evaluate(
    `(() => {
      const now = Date.now();
      const morning = new Date();
      morning.setDate(morning.getDate() + (morning.getHours() >= 8 ? 1 : 0));
      morning.setHours(8, 0, 0, 0);
      const later = new Date();
      later.setDate(later.getDate() + 2);
      later.setHours(9, 0, 0, 0);
      TASKS = [
        {id: 1, title: "Morning brief", status: "pending", due_at: morning.getTime(), payload: "Check the weather and the top three AI releases, then send a short brief.", created_at: now - 86400000, recurrence: "daily:08:00"},
        {id: 2, title: "Check the deploy health", status: "running", due_at: now - 120000, payload: "Run the health check and report any failing route.", created_at: now - 2 * 86400000, recurrence: null},
        {id: 3, title: "Summarize the handoff notes", status: "pending", due_at: later.getTime(), payload: "Read the handoff notes and list the open decisions.", created_at: now - 3 * 86400000, recurrence: null},
        {id: 4, title: "Nightly workspace snapshot", status: "done", due_at: now - 6 * 3600000, payload: "", created_at: now - 4 * 86400000, recurrence: "daily:02:00"}
      ];
      updateTaskBadge(); if (tab === "tasks") renderPage();
      return true;
    })()`,
    false
  );
  await sleep(350);
  await shot("desktop-tasks-populated");
  await theme("dark");
  await shot("desktop-tasks-dark");

  await evaluate(`TASKS = []; updateTaskBadge(); $("insp").innerHTML = insp(); true`, false);
  await theme("light");
  await go("docs");
  await shot("desktop-files");
  await evaluate(
    `(() => {
      WS = {saved: true, files: 12, bytes: 285608, updatedAt: Date.now() - 240000, limit: 25165824, overLimit: 0};
      MF = {truncated: false, files: [
        {path: "src/app.ts", bytes: 18234}, {path: "src/index.html", bytes: 41290},
        {path: "public/favicon.svg", bytes: 814}, {path: "package.json", bytes: 620},
        {path: "README.md", bytes: 3210}, {path: "tests/ui.test.mjs", bytes: 8840},
        {path: "src/styles.css", bytes: 14600}, {path: "src/widgets/tool-row.ts", bytes: 5100},
        {path: "src/widgets/approval.ts", bytes: 4300}, {path: "src/data/sessions.ts", bytes: 2700},
        {path: "public/og.png", bytes: 184000}, {path: "src/lib/format.ts", bytes: 1900}
      ]};
      WSE = ""; if (tab === "docs") renderPage();
      return true;
    })()`,
    false
  );
  await sleep(350);
  await shot("desktop-files-populated");
  await go("tools");
  await shot("desktop-tools");

  await go("chat");
  await evaluate(`st("approve"); true`, false);
  await sleep(500);
  await shot("desktop-state-approve");
  await evaluate(`st("error"); true`, false);
  await sleep(500);
  await shot("desktop-state-error");
  await evaluate(`st("success"); true`, false);
  await sleep(500);
  await shot("desktop-state-success");

  await go("chat");
  await evaluate(
    `PREVIEW = false; cur = "idle"; LOG = [
      ["u", "Run the deploy check on the worker.", Date.now() - 60000],
      ["a", "[network] The connection dropped. Blip may still be working.", Date.now()]
    ]; NF = 99; renderThread(); render(); true`,
    false
  );
  await sleep(350);
  await shot("desktop-chat-error");
  await evaluate(`LOG = []; renderThread(); render(); true`, false);

  console.log("tablet 834x1112");
  await viewport(834, 1112, true);
  await theme("light");
  await go("chat");
  await openFirstSession();
  await shot("tablet-chat");
  await evaluate(`side(1); true`, false);
  await sleep(500);
  await shot("tablet-drawer");
  await evaluate(`side(0); true`, false);

  console.log("phone 390x844");
  await viewport(390, 844, true);
  await theme("light");
  await go("chat");
  await openFirstSession();
  await shot("mobile-chat");
  await evaluate(`side(1); true`, false);
  await sleep(550);
  await shot("mobile-drawer");
  await evaluate(
    `(() => { const d = document.querySelector("details.dev"); if (d) d.open = true; return true; })()`,
    false
  );
  await sleep(350);
  await shot("mobile-drawer-states");
  await evaluate(`side(0); true`, false);
  await sleep(450);

  await syntheticTurn({ name: "mobile-chat-widgets" });
  await syntheticTurn({ name: "mobile-chat-widgets-dark", dark: true });

  await evaluate(
    `teardown(); PENDING = null; busy = false; cur = "idle"; LOG = []; renderThread(); render(); true`,
    false
  );
  await sleep(300);

  await theme("light");
  await go("tasks");
  await shot("mobile-tasks");
  await go("docs");
  await shot("mobile-files");
  await go("tools");
  await shot("mobile-tools");
  await theme("dark");
  await go("chat");
  await openFirstSession();
  await shot("mobile-chat-dark");

  await viewport(390, 844, true);
  await evaluate(`localStorage.removeItem("blip_key"); true`, false);
  await reload();
  await shot("mobile-connect");

  await finish(0);
}

async function finish(code) {
  console.log("");
  console.log(JSON.stringify({ out: OUT, shots: manifest, problems }, null, 2));
  try {
    await conn.send("Browser.close", {});
  } catch {
    // Already closing.
  }
  try {
    ws?.close();
  } catch {
    // Already closed.
  }
  try {
    proc.kill();
  } catch {
    // Already gone.
  }
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // A stray headless child still holds the profile; the OS will reap it.
  }
  process.exitCode = code;
}

main().catch(async (err) => {
  console.error("capture failed: " + (err && err.message ? err.message : String(err)));
  await finish(2);
});
