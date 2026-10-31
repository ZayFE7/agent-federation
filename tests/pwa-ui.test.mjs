// iPhone-first PWA packaging and offline basics, checked on the built console.
// Static checks plus a JSON parse of the manifest and a syntax parse of both
// scripts. The live offline flow is exercised separately by .scratch/pwa-check.mjs.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const here = new URL("../ui/", import.meta.url);
const html = readFileSync(new URL("index.html", here), "utf8");
const manifest = JSON.parse(readFileSync(new URL("manifest.webmanifest", here), "utf8"));
const sw = readFileSync(new URL("sw.js", here), "utf8");
let checks = 0;
const failures = [];
function check(name, fn) {
  checks++;
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}
function has(text, label) {
  assert.equal(html.includes(text), true, `missing ${label || JSON.stringify(text)}`);
}

check("the inline script parses", () => {
  const match = /<script>([\s\S]*)<\/script>/.exec(html);
  assert.ok(match, "no inline script found");
  new Function(match[1]);
});

check("the service worker parses", () => {
  new Function(sw);
});

check("iOS install metadata is present", () => {
  has('<link rel="manifest" href="/manifest.webmanifest">', "manifest link");
  has('name="apple-mobile-web-app-capable" content="yes"', "apple web app");
  has('name="apple-mobile-web-app-status-bar-style" content="default"', "status bar");
  has('name="apple-mobile-web-app-title"', "home screen title");
  has('rel="apple-touch-icon"', "touch icon");
  has("viewport-fit=cover", "safe-area viewport");
});

check("the manifest is installable and has maskable icons", () => {
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);
  assert.ok(manifest.icons.some((icon) => String(icon.purpose || "").includes("maskable")));
  assert.ok(manifest.icons.every((icon) => existsSync(new URL(icon.src.replace(/^\//, ""), here))));
});

check("the icons are real PNG files with app sizes", () => {
  for (const [name, width] of [["icon-180.png", 180], ["icon-192.png", 192], ["icon-512.png", 512]]) {
    const bytes = readFileSync(new URL("icons/" + name, here));
    assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG", name + " is not a PNG");
    assert.equal(bytes.readUInt32BE(16), width, name + " has the wrong width");
  }
});

check("the shell worker caches the app, excludes API data, and falls back offline", () => {
  assert.match(sw, /const VERSION = "blip-shell-/);
  assert.match(sw, /cache\.addAll\(SHELL\)/);
  assert.match(sw, /startsWith\("\/api\/"\)/);
  assert.match(sw, /request\.mode === "navigate"/);
  assert.match(sw, /new Response\("Blip is offline\."/);
});

check("the page keeps an offline copy of chats and an outbox", () => {
  has("function saveChatCache(", "chat cache save");
  has("function loadChatCache(", "chat cache load");
  has("function saveSessionsCache(", "session list cache");
  has('const CACHE_SESSIONS="blip.cache.sessions"', "session cache key");
  has("function outboxAdd(", "outbox add");
  has("function flushOutbox(", "outbox flush");
  has('id="outBar"', "outbox bar");
  has('id="offBar"', "offline banner");
  has("Saved offline. It sends when you reconnect.", "offline send copy");
  has("serviceWorker.register(\"/sw.js\"", "worker registration");
  has('addEventListener("online"', "reconnect listener");
  has('addEventListener("offline"', "offline listener");
});

check("iOS zoom and scrollbars are suppressed", () => {
  has('maximum-scale=1, user-scalable=no', "no-zoom viewport");
  has("touch-action:manipulation", "tap action");
  has("gesturestart", "pinch guard");
  has("*::-webkit-scrollbar{display:none", "scrollbar hiding");
  has("body{position:fixed;inset:0", "fixed full-screen body");
});

check("the chrome is glass and the content scrolls beneath it", () => {
  has("@supports ((-webkit-backdrop-filter: blur(1px))", "glass support block");
  has("backdrop-filter:blur(22px)", "header blur");
  has("backdrop-filter:blur(24px)", "composer blur");
  has("prefers-reduced-transparency", "transparency preference");
  has(".hd{position:absolute;top:0;left:0;right:0;z-index:30", "overlay header");
  has("z-index:25", "floating composer");
  has("function measureChrome(", "chrome measurement");
  has("visualViewport", "keyboard viewport");
});

check("iPhone standalone layout and install hint are covered", () => {
  has("display-mode: standalone", "standalone detection");
  has("env(safe-area-inset-top)", "top safe area");
  has("function installSection(", "install section");
  has("Add to Home Screen", "install copy");
});

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`pwa-ui: ${failures.length} of ${checks} failed`);
  process.exit(1);
}
console.log(`pwa-ui: ${checks} checks passed`);
