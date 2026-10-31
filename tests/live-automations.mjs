// Live webhook automation: create a trigger, fire a delivery, wait for the turn
// to finish, prove dedupe and auth, then clean up. Reads the key without printing it.

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = process.env.BLIP_URL;
if (!BASE) process.exit(2);
const ORIGIN = BASE.replace(/\/+$/, "");
const key = readFileSync(
  "C:/Users/lenovo/Desktop/BLIP-handoff/repo-clone/.dev.vars",
  "utf8"
)
  .match(/^AGENT_API_KEY=(.+)$/m)[1]
  .trim()
  .replace(/^["']|["']$/g, "");
const auth = { authorization: `Bearer ${key}` };
const jsonAuth = { ...auth, "content-type": "application/json" };
const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function api(path, init = {}) {
  const res = await fetch(ORIGIN + path, { ...init, headers: init.headers || auth });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function fail(label, extra) {
  console.error(`FAIL ${label}${extra === undefined ? "" : `: ${JSON.stringify(extra).slice(0, 800)}`}`);
  process.exit(1);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createdSession = await api("/api/sessions", {
  method: "POST",
  headers: jsonAuth,
  body: "{}",
});
const sessionId = createdSession.body?.session?.id;
if (!sessionId) fail("create target session", createdSession.body);

const created = await api("/api/automations", {
  method: "POST",
  headers: jsonAuth,
  body: JSON.stringify({
    name: `Live hook ${nonce}`,
    kind: "webhook",
    target_session_id: sessionId,
    instructions:
      "Reply with exactly AUTOMATION-OK. Do not use tools and do not add anything else.",
    source: { type: "webhook", auth: "secret" },
  }),
});
if (created.status !== 201 || !created.body?.automation?.id || !created.body?.secret) {
  fail("create automation", created.body);
}
const automationId = created.body.automation.id;
const secret = created.body.secret;
const hookPath = created.body.webhookPath;
console.log(`automation=${automationId} target=${sessionId}`);

const eventId = `live-${nonce}`;
const payload = JSON.stringify({ action: "opened", issue: { number: 42 }, nonce });
const first = await fetch(`${ORIGIN}${hookPath}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-event-id": eventId },
  body: payload,
});
if (first.status !== 202) fail("first delivery", { status: first.status, body: await first.text() });

const duplicate = await fetch(`${ORIGIN}${hookPath}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-event-id": eventId },
  body: payload,
});
const duplicateBody = await duplicate.json().catch(() => null);
if (duplicate.status !== 200 || duplicateBody?.duplicate !== true) {
  fail("duplicate delivery", { status: duplicate.status, body: duplicateBody });
}

const bad = await fetch(`${ORIGIN}/hooks/${automationId}/not-the-secret`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: payload,
});
if (bad.status !== 401) fail("bad secret", bad.status);

let run = null;
let events = [];
for (let i = 0; i < 60; i++) {
  const runs = await api(`/api/automations/${automationId}/runs`);
  run = (runs.body?.runs || [])[0] || null;
  const ev = await api(`/api/automations/${automationId}/events`);
  events = ev.body?.events || [];
  if (run && (run.status === "done" || run.status === "failed" || run.status === "abandoned")) break;
  await sleep(2000);
}
if (!run) fail("no run was created");
if (run.status !== "done") fail("run did not finish", run);
if (!String(run.reply || "").toUpperCase().includes("AUTOMATION-OK")) {
  fail("reply did not contain the marker", run.reply);
}
const event = events.find((e) => e.event_key === eventId);
if (!event || event.status !== "done") fail("event did not reach done", event);

const messages = await api(`/api/sessions/${sessionId}/messages`);
const transcript = (messages.body?.messages || []).map((m) => String(m.content || "")).join("\n");
if (!transcript.includes("[Automation:")) fail("automation marker missing from transcript");
if (!transcript.toUpperCase().includes("AUTOMATION-OK")) fail("assistant reply missing from transcript");

await api(`/api/automations/${automationId}/control`, {
  method: "POST",
  headers: jsonAuth,
  body: JSON.stringify({ action: "pause" }),
});
const pausedDelivery = await fetch(`${ORIGIN}${hookPath}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-event-id": `paused-${nonce}` },
  body: payload,
});
const pausedBody = await pausedDelivery.json().catch(() => null);
if (!pausedBody?.skipped) fail("paused delivery was not skipped", pausedBody);

const github = await api("/api/automations", {
  method: "POST",
  headers: jsonAuth,
  body: JSON.stringify({
    name: `Live GitHub ${nonce}`,
    kind: "github",
    target_session_id: sessionId,
    instructions: "Reply with exactly GITHUB-OK.",
    source: { type: "webhook", auth: "github" },
    match: { path: "action", op: "eq", value: "never" },
  }),
});
if (github.status !== 201 || !github.body?.secret) fail("create github automation", github.body);
const githubId = github.body.automation.id;
const githubSecret = github.body.secret;
const githubBody = JSON.stringify({ action: "closed" });
const signature = `sha256=${createHmac("sha256", githubSecret).update(githubBody).digest("hex")}`;
const signed = await fetch(`${ORIGIN}/hooks/${githubId}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-github-delivery": `gh-${nonce}`,
    "x-github-event": "issues",
    "x-hub-signature-256": signature,
  },
  body: githubBody,
});
const signedBody = await signed.json().catch(() => null);
if (signed.status !== 202 || signedBody?.skipped !== true) {
  fail("valid GitHub HMAC was not accepted and skipped by condition", { status: signed.status, body: signedBody });
}
const unsigned = await fetch(`${ORIGIN}/hooks/${githubId}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-github-delivery": `bad-${nonce}` },
  body: githubBody,
});
if (unsigned.status !== 401) fail("missing GitHub signature", unsigned.status);
await api(`/api/automations/${githubId}`, { method: "DELETE", headers: auth });

await api(`/api/automations/${automationId}`, { method: "DELETE", headers: auth });
await api(`/api/sessions/${encodeURIComponent(sessionId)}`, {
  method: "DELETE",
  headers: jsonAuth,
  body: JSON.stringify({ confirm_body: true }),
});

console.log(`PASS automation webhook: run=${run.id} reply=${JSON.stringify(run.reply.slice(0, 80))}`);
