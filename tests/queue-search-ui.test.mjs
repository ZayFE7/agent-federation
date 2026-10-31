// The shipped console must queue a message behind a running turn and search
// across chat transcripts. Static checks on the built UI so a rebuild cannot
// silently drop either, plus a syntax parse of the one inline script.

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

check("the inline script parses", () => {
  const match = /<script>([\s\S]*)<\/script>/.exec(html);
  assert.ok(match, "no inline script found");
  new Function(match[1]);
});

check("the queue bar exists in the composer and survives reload", () => {
  has('id="qBar"', "queue bar element");
  has("queueLoad", "queue read helper");
  has("queueSave", "queue write helper");
  has("blip.queue.", "per-session queue key");
  has("pumpQueue", "queue pump");
  has("pruneQueue", "transcript-based queue prune");
  has("Queued. It runs when this turn finishes.", "queued toast");
});

check("sending while busy queues instead of stopping", () => {
  has("const wasBusy=busy", "busy snapshot at send time");
  has("j.queued&&wasBusy", "queued receipt branch");
  has("The message was not queued", "honest queue failure");
  has("Stop the current turn before sending a command.", "directive guard");
});

check("stop clears the queue and aborts everything open", () => {
  has("Queued messages were removed.", "stop copy");
  has('"/abort",{method:"POST"}', "abort-all request");
});

check("cross-session search is wired to the route and the sidebar", () => {
  has("/api/sessions/search?q=", "search endpoint call");
  has("searchInput(this.value)", "search input handler");
  has("searchHsHTML", "results renderer");
  has("In messages", "results group label");
  has("No message matches that search.", "empty result copy");
});

check("the composer hint and button describe the queue", () => {
  has("Queue this message for after the current turn", "send title while busy");
  has('aria-label="Send or queue"', "send label");
});

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`queue-search-ui: ${failures.length} of ${checks} failed`);
  process.exit(1);
}
console.log(`queue-search-ui: ${checks} checks passed`);
