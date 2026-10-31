// The shipped console must carry the Goals page and its controls. Static checks
// on the built ui/index.html so a rebuild that drops the page fails here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
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
function hasNot(text, label) {
  assert.equal(html.includes(text), false, `unexpected ${label || JSON.stringify(text)}`);
}

check("Goals is a primary nav page with its own title", () => {
  has('goals:["Goals","goal"]', "Goals nav item");
  has('goals:"Goals"', "Goals page title");
  has("goalbadge", "goal attention badge");
});

check("the list and detail pages render", () => {
  has("function pGoals()", "Goals list renderer");
  has("function pGoalDetail()", "goal detail renderer");
  has('api("/api/goals")', "goals list endpoint");
  has("/api/goals/attention", "goal attention endpoint");
  has("/api/goals/pause-all", "global pause endpoint");
  has("/events?limit=200", "event audit read");
  has("startGoalPoll", "live polling");
});

check("creating a goal asks for the outcome and proof", () => {
  for (const id of ["gTitle", "gBrief", "gCriteria", "gCopy"]) {
    has(`id="${id}"`, `goal form field ${id}`);
  }
  has("Success criteria", "criteria label");
  has("Copy this chat's files", "workspace copy option");
  has("origin_session_id", "origin session field");
  has('api("/api/goals",{method:"POST"', "create endpoint");
});

check("every control the runtime supports is on screen", () => {
  has("Pause all", "global pause control");
  has("Retry step", "blocked step retry");
  has("Add instruction", "instruction control");
  has("Cancel goal", "cancel control");
  has("Open goal chat", "link to the dedicated chat");
  has("Needs you", "attention inbox heading");
});

check("attention can reach the browser while the tab is open", () => {
  has("Enable alerts", "alert permission control");
  has("browserAlert", "browser notification hook");
  has("attentionHTML", "unified attention inbox");
});

check("Settings exposes hybrid memory with its honest mode", () => {
  has("/api/memory?q=", "memory search endpoint");
  has("Semantic recall", "semantic status copy");
  has("Keyword recall", "keyword fallback copy");
  has("Search memory", "memory search field");
});

check("goal templates prefill a real outcome", () => {
  has("GOAL_TEMPLATES", "goal template table");
  has("goalTemplate('inbox')", "inbox template control");
  has("goalTemplate('research')", "research template control");
  has("goalTemplate('tidy')", "workspace template control");
});

check("drafts and file versions survive navigation", () => {
  has("blip.draft.", "per-chat draft key");
  has("restoreDraft", "draft restore on open");
  has("fileVersions(", "version history dialog");
  has("restoreVersion(", "version restore action");
  has("/files/versions?path=", "version list endpoint");
  has("/files/restore", "version restore endpoint");
});

check("the Goals page makes no future-tense promise", () => {
  hasNot("not wired", "unwired promise");
  hasNot("coming soon", "coming-soon promise");
});

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`goals-ui: ${failures.length} of ${checks} failed`);
  process.exit(1);
}
console.log(`goals-ui: ${checks} checks passed`);
