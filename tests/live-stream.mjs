#!/usr/bin/env node
// Live streaming probe for the deployed Blip agent (plan Task 37).
// Usage: BLIP_URL=<origin> node tests/live-stream.mjs
//
// One model turn, one durable stream, four numbers: time to the first text
// frame, frame count, tool starts/results, and terminal frames. A clean turn
// has exactly one terminal frame and as many tool results as starts; a turn
// that streams its first text later than 12 s fails, because the console is
// supposed to feel live, not eventual.
//
// Exit codes: 0 pass, 1 fail, 2 setup error. Never prints the key.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TIMEOUT_MS = 120_000;
const FIRST_TEXT_BUDGET_MS = 12_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_VARS = join(HERE, "..", ".dev.vars");

const BASE = process.env.BLIP_URL;
if (!BASE) {
  console.error("FATAL: BLIP_URL is not set (scheme + host only, no path).");
  process.exit(2);
}
const ORIGIN = BASE.replace(/\/+$/, "");
const PLACEHOLDER_RE = /^(generate-me|change-me|replace-me|your[-_]?key[-_]?here|todo|xxx+)$/i;

function readApiKey() {
  let raw;
  try {
    raw = readFileSync(DEV_VARS, "utf8");
  } catch (err) {
    console.error(`FATAL: cannot read ${DEV_VARS}: ${err.message}`);
    process.exit(2);
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^AGENT_API_KEY=(.+)$/);
    if (!m) continue;
    const value = m[1].trim().replace(/^["']|["']$/g, "");
    if (PLACEHOLDER_RE.test(value)) {
      console.error(`FATAL: AGENT_API_KEY in ${DEV_VARS} is still the placeholder.`);
      process.exit(2);
    }
    return value;
  }
  console.error(`FATAL: no AGENT_API_KEY= line in ${DEV_VARS}.`);
  process.exit(2);
}

async function api(path, apiKey, init, signal) {
  return fetch(ORIGIN + path, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...((init && init.headers) || {}),
    },
    signal,
  });
}

async function createSession(apiKey, signal) {
  const res = await api("/api/sessions", apiKey, { method: "POST" }, signal);
  const body = await res.json().catch(() => null);
  const id = body && body.session && body.session.id;
  if (res.status !== 200 || typeof id !== "string") {
    throw new Error(`create session: HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return id;
}

async function submitTurn(sessionId, content, apiKey, signal) {
  const res = await api(
    `/api/sessions/${sessionId}/message`,
    apiKey,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    },
    signal
  );
  const body = await res.json().catch(() => null);
  if (res.status !== 200 || !body || typeof body.streamId !== "string") {
    throw new Error(`submit: HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body.streamId;
}

async function readStream(sessionId, streamId, apiKey, signal) {
  const res = await api(
    `/api/sessions/${sessionId}/stream/${encodeURIComponent(streamId)}`,
    apiKey,
    { headers: { accept: "text/event-stream" } },
    signal
  );
  if (res.status !== 200 || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`stream HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buf = "";
  let terminal = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        let frame;
        try {
          frame = JSON.parse(raw);
        } catch {
          continue;
        }
        frame.atMs = Date.now();
        frames.push(frame);
        if (frame.t === "done" || frame.t === "error") terminal = true;
      }
    }
    if (terminal) {
      try {
        await reader.cancel();
      } catch {
        // already closed
      }
      break;
    }
  }
  return frames;
}

async function deleteSession(sessionId, apiKey) {
  try {
    await api(`/api/sessions/${sessionId}`, apiKey, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm_body: true }),
    });
  } catch {
    // Cleanup is best effort; a stranded probe session is noise, not a result.
  }
}

const apiKey = readApiKey();
const ctl = new AbortController();
const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
let sessionId = null;
let passed = false;
let detail = "";

try {
  const started = Date.now();
  sessionId = await createSession(apiKey, ctl.signal);
  const streamId = await submitTurn(
    sessionId,
    "Write a three-line poem about the sea. Answer with the poem only.",
    apiKey,
    ctl.signal
  );
  const frames = await readStream(sessionId, streamId, apiKey, ctl.signal);
  const elapsed = Date.now() - started;

  const typed = frames.filter((f) => typeof f.t === "string");
  const firstText = typed.find((f) => f.t === "text" && String(f.d ?? "").length > 0);
  const firstTextFrameMs = firstText ? Math.max(0, firstText.atMs - started) : null;
  const toolStarts = typed.filter((f) => f.t === "tool-start").length;
  const toolResults = typed.filter((f) => f.t === "tool-result").length;
  const terminalFrames = typed.filter((f) => f.t === "done" || f.t === "error").length;
  const done = typed.find((f) => f.t === "done");
  const errorFrame = typed.find((f) => f.t === "error");

  console.log(`live-stream -> ${ORIGIN}`);
  console.log(`key         : redacted (${apiKey.length} chars read from .dev.vars)`);
  console.log(`session     : ${sessionId}`);
  console.log(`stream      : ${streamId}`);
  console.log(`elapsedMs   : ${elapsed}`);
  console.log(`firstTextMs : ${firstTextFrameMs ?? "-"}`);
  console.log(`frameCount  : ${typed.length}`);
  console.log(`toolStarts  : ${toolStarts}`);
  console.log(`toolResults : ${toolResults}`);
  console.log(`terminalFrames: ${terminalFrames}`);
  console.log(`reply[0..160]: ${String(done ? done.reply ?? "" : "").slice(0, 160).replace(/\r?\n/g, "\\n")}`);
  if (errorFrame) console.log(`error       : ${String(errorFrame.message ?? "").slice(0, 200)}`);

  const problems = [];
  if (!done) problems.push("no done frame");
  if (terminalFrames !== 1) problems.push(`terminalFrames=${terminalFrames}, expected 1`);
  if (toolResults !== toolStarts) problems.push(`toolResults=${toolResults} != toolStarts=${toolStarts}`);
  if (firstTextFrameMs === null) problems.push("no non-empty text frame");
  else if (firstTextFrameMs >= FIRST_TEXT_BUDGET_MS) {
    problems.push(`firstTextMs=${firstTextFrameMs} >= ${FIRST_TEXT_BUDGET_MS}`);
  }

  if (problems.length === 0) {
    passed = true;
    detail = "one terminal frame, balanced tool frames, first text under budget";
  } else {
    detail = problems.join("; ");
  }
} catch (err) {
  detail = err && err.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : String(err && err.message ? err.message : err);
} finally {
  clearTimeout(timer);
  if (sessionId) await deleteSession(sessionId, apiKey);
}

console.log(`criteria    : terminalFrames === 1, toolResults === toolStarts, firstTextMs < ${FIRST_TEXT_BUDGET_MS}`);
console.log(`result      : ${passed ? "PASS" : "FAIL"} (${detail})`);
process.exit(passed ? 0 : 1);
