// Source checks for the Connections page: the native Gmail connector plus the
// MCP server management moved out of Settings. The page is built into a single
// ui/index.html, so these assertions run against exactly what ships.
// The one inline script is also extracted and parsed with node --check.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(HERE, "..", "ui", "index.html");
const html = readFileSync(HTML_PATH, "utf8");

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}
function has(text, label) {
  assert.equal(html.includes(text), true, `missing ${label || JSON.stringify(text)}`);
}
function hasNot(text, label) {
  assert.equal(html.includes(text), false, `unexpected ${label || JSON.stringify(text)}`);
}
function slice(start, end) {
  const from = html.indexOf(start);
  assert.notEqual(from, -1, `missing section start ${JSON.stringify(start)}`);
  const to = html.indexOf(end, from);
  assert.notEqual(to, -1, `missing section end ${JSON.stringify(end)}`);
  return html.slice(from, to);
}

check("Connections sits between Automations and Files in the nav and titles", () => {
  has('["tasks","Automations","loop"', "Automations tile");
  has('["connections","Connections","conn"', "Connections tile");
  has('["docs","Files","files"', "Files tile");
  assert.ok(html.indexOf('["tasks","Automations","loop"') < html.indexOf('["connections","Connections","conn"') && html.indexOf('["connections","Connections","conn"') < html.indexOf('["docs","Files","files"'), "Connections sits between Automations and Files");
  has('connections:"Connections"', "Connections page title");
  has("connections:pConnections", "Connections page renderer");
  has('function go(t){', "view router");
  has('if(t==="connections"){loadGoogleConnections();loadComposioConnectors();startConnPoll()}', "connections loader on navigation");
});

check("the page has Gmail, MCP servers and Google setup sections", () => {
  has('<h1>Connections</h1>', "page heading");
  has('id="conn-gmail"', "Gmail section anchor");
  has('id="conn-mcp"', "MCP section anchor");
  has('id="conn-google"', "Google setup section anchor");
  has("<span>Gmail</span>", "Gmail section heading");
  has("<span>MCP servers</span>", "MCP section heading");
  has("<span>Google setup</span>", "Google setup section heading");
});

check("Gmail status and account calls use the real routes", () => {
  has('api("/api/connections/google/status")', "status endpoint");
  has('api("/api/connections/google/accounts")', "accounts endpoint");
  has('api("/api/connections/google/start"+q)', "start endpoint");
  has('const q=email?"?login_hint="+encodeURIComponent(email):""', "login hint query");
  has('api("/api/connections/google/default",{method:"PUT"', "set default endpoint");
  has("JSON.stringify({id})", "set default body");
  has('api("/api/connections/google/accounts/"+encodeURIComponent(id),{method:"DELETE"}', "disconnect endpoint");
  has("location.href=target.href", "browser navigation to Google");
});

check("the missing-config setup card carries the checklist and exact redirect URI", () => {
  has("Gmail is not configured", "missing configuration heading");
  has("GOOGLE_CLIENT_ID", "client id secret name");
  has("GOOGLE_CLIENT_SECRET", "client secret name");
  has("Create a Google Cloud project", "project step");
  has("Enable the Gmail API", "Gmail API step");
  has("OAuth consent screen", "consent step");
  has("Choose External", "External user type");
  has("Testing", "Testing publishing status");
  has("test user", "test users step");
  has("Web application", "web OAuth client step");
  has("Authorized redirect URI", "redirect URI label");
  has("state.googleStatus.redirectUri", "redirect URI from the status response");
  has("Connect is disabled", "disabled Connect explanation");
  has('<button class="btn p" disabled aria-disabled="true"', "disabled Connect button");
  has("copyGoogleRedirect", "copy redirect URI control");
});

check("Connect, Reconnect, Set default and Disconnect are wired", () => {
  has("startGoogleAuth()", "Connect Gmail action");
  has("Connect Gmail", "Connect Gmail label");
  has('onclick="startGoogleAuth(this.dataset.email)"', "Reconnect with the account email");
  has(">Reconnect</button>", "Reconnect button");
  has('onclick="setGoogleDefault(this.dataset.id)"', "Set default action");
  has(">Set default</button>", "Set default button");
  has('onclick="disconnectGoogle(this.dataset.id,this.dataset.email)"', "Disconnect action");
  has(">Disconnect</button>", "Disconnect button");
  has("confirmDialog({title:\"Disconnect Gmail?\"", "disconnect confirmation");
});

check("account cards expose identity, default, status, scope and errors", () => {
  has('class="gacct', "account card class");
  has('class="gavatar ginit"', "picture or initial avatar");
  has("a.picture", "picture field");
  has("a.email", "email field");
  has("a.name", "name field");
  has("is_default", "default flag");
  has(">Default</span>", "default badge");
  has("GOOGLE_STATUSES", "status label map");
  has("reauth_required", "reconnect-required status");
  has("revoked", "revoked status");
  has("Reconnect required", "reconnect-required label");
  has("Mailbox scope", "mailbox scope field");
  has("Full mailbox", "full mailbox indicator");
  has("GMAIL_FULL_SCOPE", "full Gmail scope constant");
  has("Last refresh", "last refresh field");
  has("last_refresh_at", "last refresh response field");
  has("Last error", "last error field");
  has("last_error", "last error response field");
});

check("the Testing-mode seven-day warning is present", () => {
  has("Testing-mode warning", "testing warning heading");
  has("refresh tokens expire after 7 days", "seven day expiry");
  has("Reconnect weekly", "weekly reconnect");
  has("publish the OAuth app", "publish guidance");
});

check("OAuth callback query params open Connections, toast and are removed", () => {
  has("consumeGoogleReturn", "callback consumer");
  has('p.get("google")', "google query param read");
  has('p.get("reason")', "reason query param read");
  has("history.replaceState", "query cleanup");
  has('u.searchParams.delete("google")', "google param removal");
  has('u.searchParams.delete("reason")', "reason param removal");
  has('tab="connections"', "opens Connections");
  has("toast(\"Gmail connected.\")", "connected toast");
  has("googleReasonText", "error reason mapping");
  has("bootLoad().then(consumeGoogleReturn)", "boot callback handling");
});

check("loading, missing-key, failure and empty states are handled", () => {
  has("Checking Google setup", "status loading state");
  has("Reading Gmail accounts", "accounts loading state");
  has("Reading MCP servers", "MCP loading state");
  has("Could not read Google setup", "status failure state");
  has("Could not read Gmail accounts", "accounts failure state");
  has("Could not read MCP servers", "MCP failure state");
  has("The agent key was rejected", "401 copy");
  has("Connect your agent", "missing key state");
  has("No Gmail accounts connected", "empty account state");
  has("No MCP servers", "empty MCP state");
  has("Reconnect required", "reauth inline state");
});

check("MCP cards, counts, dialog and controls moved out of Settings", () => {
  has("function mcpSectionHTML()", "MCP section renderer");
  has("function mcpServerCard(s)", "MCP card renderer");
  has("server${servers.length===1", "server count");
  has("tool${tools.length===1", "tool count");
  has("mcpcount", "per-server tool count");
  has('id="mName"', "server name field");
  has('id="mUrl"', "server URL field");
  has('id="mHk"', "optional header name field");
  has('id="mHv"', "optional header value field");
  has(">Authorize</button>", "OAuth authorize control");
  has('onclick="reconnectMcp(this.dataset.id)"', "MCP reconnect control");
  has('onclick="removeMcp(this.dataset.id)"', "MCP remove control");
  has('api("/api/mcp/servers")', "MCP list endpoint");
  has('api("/api/mcp/servers/"+encodeURIComponent(id)+"/reconnect"', "MCP reconnect endpoint");
  has("OAuth servers open their provider page", "OAuth description");
  const settings = slice("function pSettings(){", "function mcpDialog(){");
  assert.equal(settings.includes("state.mcpServers"), false, "Settings still renders MCP servers");
  assert.equal(settings.includes("mcpServerCard"), false, "Settings still renders MCP cards");
  assert.equal(settings.includes("loadMcpServers"), false, "Settings still loads MCP servers");
  assert.equal(settings.includes("mcpDialog()"), false, "Settings still opens the MCP dialog");
  assert.equal(settings.includes("Open Connections"), true, "Settings has no Connections link");
});

check("no token or client-secret value is exposed to the browser", () => {
  hasNot("refresh_enc", "encrypted refresh token");
  hasNot("refreshToken", "refresh token field");
  hasNot("accessToken", "access token field");
  hasNot("clientSecret=", "client secret assignment");
  hasNot("code=authorization_code", "authorization code");
});

check("polling is visibility-gated and rendering is signature-guarded", () => {
  has("CONNSIG", "connections signature");
  has("function connSig()", "signature builder");
  has("function renderConnections(force)", "guarded renderer");
  has("if(!force&&sig===CONNSIG)return", "render guard");
  has("setInterval(connTick,20000)", "20s Gmail poll");
  has("if(tab!==\"connections\"||document.hidden)return", "poll visibility guard");
  has('if(tab==="connections"){loadGoogleStatus();loadGoogleAccounts();loadComposioConnectors()}', "refresh on visibility");
  has("stopConnPoll", "poll teardown");
});

check("the Connections layout has mobile CSS hooks", () => {
  has('<div class="conn">', "connections wrapper");
  has(".connhead{flex-wrap:wrap}", "wrapping header");
  has(".gacct{", "account card");
  has(".gmeta{display:grid", "account metadata grid");
  has(".gacts{display:flex", "account action row");
  has(".gsteps{", "setup checklist");
  has(".gredir{", "redirect URI block");
  has("@media (max-width:560px){", "phone breakpoint");
  has(".pgw{padding:18px 14px", "full-width phone page padding");
  has(".gacts .btn{flex:1 1 100%", "reachable stacked mobile buttons");
  has(".gmeta{grid-template-columns:1fr 1fr", "stacked account metadata");
});

check("the shipped script is a single block that parses", () => {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1, `expected one script block, found ${blocks.length}`);
  const dir = mkdtempSync(join(tmpdir(), "blip-gmail-ui-"));
  const scriptPath = join(dir, "app.js");
  try {
    writeFileSync(scriptPath, blocks[0][1], "utf8");
    const parsed = spawnSync(process.execPath, ["--check", scriptPath], { encoding: "utf8" });
    assert.equal(
      parsed.status,
      0,
      `node --check failed (${parsed.status}): ${parsed.stderr || parsed.stdout || parsed.error}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

if (failures.length > 0) {
  console.log(`FAIL ${failures.length} Gmail UI check${failures.length === 1 ? "" : "s"}`);
  for (const failure of failures) console.log(`- ${failure}`);
  process.exit(1);
}
console.log("PASS Gmail UI");
