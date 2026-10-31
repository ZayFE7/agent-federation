// Source checks for the shipped Automations console. The page is built into a
// single ui/index.html, so these assertions run against exactly what ships.
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

check("Automations replaces Tasks in the nav and page title", () => {
  has('["tasks","Automations","loop"', "Automations nav item");
  has('tasks:"Automations"', "Automations page title");
  hasNot('tasks:["Tasks"', "old Tasks nav label");
  hasNot("<h1>Tasks</h1>", "old Tasks page heading");
});

check("Triggers and Scheduled live on the same page", () => {
  has(">Triggers<", "Triggers section");
  has(">Scheduled<", "Scheduled section");
  has("autoScheduledHTML", "scheduled section renderer");
  has("/api/tasks", "existing scheduled jobs loader");
  has('class="task"', "existing scheduled row styling");
});

check("the create form includes every source field", () => {
  for (const id of ["aName", "aKind", "aChat", "aInstr", "aUrl", "aMin", "aFirst", "aHeaders", "aEvery", "aDaily", "aCond"]) {
    has(`id="${id}"`, `form field ${id}`);
  }
  for (const kind of ['value="webhook"', 'value="github"', 'value="watch"', 'value="schedule"']) {
    has(kind, `kind option ${kind}`);
  }
  has("every_minutes", "interval schedule field");
  has("daily_at", "daily schedule field");
  has('min="5"', "five minute floor");
  has("Fire on the first check", "watch first check option");
  has('placeholder=\'{"all":[{"path":"action","op":"eq","value":"opened"}]}\'', "condition example");
  has("target_session_id", "target chat payload");
  has('api("/api/automations",{method:"POST"', "create endpoint");
});

check("webhook URL and secret-once flow is present", () => {
  has("Secret shown once", "secret-once label");
  has("location.origin", "absolute webhook URL construction");
  has("webhookPath", "returned webhook path");
  has("githubPath", "returned GitHub path");
  has("Copy secret", "copy secret button");
  has("Copy URL", "copy URL button");
  has("secret_hint", "secret hint only in views");
  hasNot("secret_enc", "encrypted secret must never reach the browser");
});

check("rotation, pause/resume, delete and preview are wired", () => {
  has("Rotate secret", "rotate button");
  has("rotate_secret", "rotate control action");
  has("autoRotate", "rotate handler");
  has("Pause all", "pause-all button");
  has("Resume all", "resume-all button");
  has("/api/automations/pause-all", "pause-all endpoint");
  has("/api/automations/resume-all", "resume-all endpoint");
  has("All automations are paused", "paused banner");
  has("Preview prompt", "preview button");
  has('action:"preview"', "preview control action");
  has("Delete automation", "delete confirmation");
});

check("detail shows events, runs, errors and next run", () => {
  has("/events?limit=50", "events endpoint");
  has("/runs?limit=50", "runs endpoint");
  has("autoEventsHTML", "events timeline");
  has("autoRunsHTML", "runs timeline");
  has("Last error", "last error field");
  has("Next run", "next run field");
  has("autoSourceSummary", "source summary");
  has("Back to list", "back navigation");
});

check("the attention inbox and badge use the new routes", () => {
  has("attentionHTML", "attention inbox renderer");
  has("Needs you", "Needs you status");
  has("/api/automations/attention", "attention endpoint");
  has('id="autobadge"', "sidebar attention badge");
});

check("polling is visibility-gated and signature-guarded", () => {
  has("document.visibilityState", "visibility guard");
  has("setInterval(autoTick,3000)", "3s Automations poll");
  has("setInterval(autoAmbientTick,10000)", "10s ambient poll");
  has("AUTOSIG", "list signature");
  has("AUTODETAILSIG", "detail signature");
  for (const name of ["AUTOMATIONS", "AUTOMATIONSErr", "AUTOPAUSED", "AUTOSEL", "AUTODETAIL", "AUTOEVENTS", "AUTORUNS"]) {
    has(name, `state ${name}`);
  }
});

check("mobile sheet and stacked rows are styled with existing tokens", () => {
  has("@media (max-width:560px)", "mobile breakpoint");
  has("dialog.autodlg", "full-screen dialog hook");
  has("100dvh", "dynamic viewport height");
  has(".dlg.autoform", "create sheet style");
  has(".ameta", "automation metadata grid");
  has(".aacts", "automation action row");
  has("var(--soft)", "one-time secret uses the existing highlight token");
});

check("the shipped script is a single block that parses", () => {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1, `expected one script block, found ${blocks.length}`);
  const dir = mkdtempSync(join(tmpdir(), "blip-automation-ui-"));
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
  console.log(`FAIL ${failures.length} automation UI check${failures.length === 1 ? "" : "s"}`);
  for (const failure of failures) console.log(`- ${failure}`);
  process.exit(1);
}
console.log("PASS automation UI");
