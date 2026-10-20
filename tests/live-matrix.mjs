#!/usr/bin/env node
// Live smoke matrix for the deployed Blip agent, over the durable stream.
// Usage: point BLIP_URL at the origin you deployed, put a real key in .dev.vars,
// then run: node tests/live-matrix.mjs
//
// Every probe creates a session, POSTs one turn, then reads that turn's
// operation stream as SSE until `done`. The stream is the only surface the
// console uses, so it is the only surface this matrix tests.
// Exit code 0 only when all four probes PASS, 1 on any FAIL, 2 on setup errors.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EXPECTED_TOOLS, capabilitiesText } from "../src/capabilities.ts";

const TIMEOUT_MS = 120_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_VARS = join(HERE, "..", ".dev.vars");

// No default host, on purpose: with a fallback this script tests somebody
// else's deployment instead of yours and prints PASS for work you did not ship.
const BASE = process.env.BLIP_URL;
if (!BASE) {
  console.error("FATAL: BLIP_URL is not set. set BLIP_URL to the origin of the");
  console.error("worker you deployed (scheme + host only, no path), for example:");
  console.error('  cmd:  set BLIP_URL=<your origin> then run this file again');
  console.error('  sh:   export BLIP_URL="<your origin>"');
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
      console.error(
        `FATAL: AGENT_API_KEY in ${DEV_VARS} is still the placeholder "${value}".`
      );
      console.error("Set a real key there (and as a secret on the worker) and re-run.");
      process.exit(2);
    }
    return value;
  }
  console.error(`FATAL: no AGENT_API_KEY= line found in ${DEV_VARS}. Set a real key there.`);
  process.exit(2);
}

const CASES = [
  {
    id: 1,
    label: "ping",
    content: "say pong",
    check(env) {
      return !!env.done && /pong/i.test(String(env.done.reply ?? ""));
    },
    why: "the done frame's reply contains 'pong' (case-insensitive)",
  },
  {
    id: 2,
    label: "deterministic tool run",
    content: "run: echo blip-can-run",
    check(env) {
      const start = env.frames.find(
        (f) =>
          f.t === "tool-start" &&
          f.name === "exec" &&
          String(f.input ?? "").includes("echo blip-can-run")
      );
      const result =
        start &&
        env.frames.find(
          (f) =>
            f.t === "tool-result" &&
            f.id === start.id &&
            String(f.output ?? "").includes("blip-can-run")
        );
      return !!start && !!result;
    },
    why: "a tool-start names exec with input 'echo blip-can-run' AND the same id's tool-result output includes 'blip-can-run'",
  },
  {
    id: 3,
    label: "capabilities",
    content: "what can you do",
    check(env) {
      const reply = String(env.reply ?? "");
      return (
        reply.includes(capabilitiesText(EXPECTED_TOOLS)) &&
        !reply.toLowerCase().includes("planned")
      );
    },
    why: "the reply contains capabilitiesText(EXPECTED_TOOLS) and does not say 'planned'",
  },
  {
    id: 4,
    label: "freeform generation",
    content: "write a 2-line poem about butterflies",
    check(env) {
      const doneAt = env.frames.findIndex((f) => f.t === "done");
      if (doneAt < 0) return false;
      const texts = env.frames
        .slice(0, doneAt)
        .filter((f) => f.t === "text" && String(f.d ?? "").length > 0);
      return texts.length >= 3;
    },
    why: "at least 3 non-empty text frames arrive before done",
  },
];

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
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const id = body && body.session && body.session.id;
  if (res.status !== 200 || typeof id !== "string") {
    throw new Error(`create session: HTTP ${res.status}: ${text.slice(0, 200)}`);
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
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (res.status !== 200 || !body || typeof body.streamId !== "string") {
    throw new Error(`submit: HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return body.streamId;
}

/** Read one `data:`-framed SSE response until a terminal frame or EOF. */
async function readStream(sessionId, streamId, apiKey, signal) {
  const res = await api(
    `/api/sessions/${sessionId}/stream/${encodeURIComponent(streamId)}`,
    apiKey,
    { headers: { accept: "text/event-stream" } },
    signal
  );
  if (res.status !== 200 || !res.body) {
    const text = await res.text().catch(() => "");
    return { status: res.status, frames: [], error: `stream HTTP ${res.status}: ${text.slice(0, 200)}` };
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
        frames.push(frame);
        if (frame.t === "done" || frame.t === "error") terminal = true;
      }
    }
    if (terminal) {
      try {
        await reader.cancel();
      } catch {
        // Already closed by the server; nothing to release.
      }
      break;
    }
  }
  return { status: res.status, frames, error: null };
}

async function runCase(kase, apiKey) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let sessionId = null;
  let streamId = null;
  let streamStatus = 0;
  let frames = [];
  let netError = null;
  try {
    sessionId = await createSession(apiKey, ctl.signal);
    streamId = await submitTurn(sessionId, kase.content, apiKey, ctl.signal);
    const got = await readStream(sessionId, streamId, apiKey, ctl.signal);
    streamStatus = got.status;
    frames = got.frames;
    if (got.error) netError = got.error;
  } catch (err) {
    netError =
      err && err.name === "AbortError"
        ? `timeout after ${TIMEOUT_MS}ms`
        : String(err && err.message ? err.message : err);
  } finally {
    clearTimeout(timer);
  }
  const ms = Date.now() - started;

  const done = frames.find((f) => f.t === "done") || null;
  const errorFrame = frames.find((f) => f.t === "error") || null;
  const reply = String(done ? done.reply ?? "" : "");
  const counts = {};
  for (const f of frames) counts[f.t] = (counts[f.t] || 0) + 1;
  const env = { frames, reply, done };

  const httpOk = streamStatus === 200;
  const passed =
    httpOk &&
    netError === null &&
    errorFrame === null &&
    kase.check(env);

  console.log(`--- [${kase.id}] ${kase.label} ---`);
  console.log(`  body     : ${JSON.stringify({ content: kase.content })}`);
  console.log(`  session  : ${sessionId ?? "-"}`);
  console.log(`  stream   : ${streamId ?? "-"}`);
  console.log(
    `  status   : ${httpOk ? 200 : streamStatus}${netError ? ` (network: ${netError})` : ""}  (${ms}ms)`
  );
  console.log(`  frames   : ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ") || "-"}`);
  if (errorFrame) console.log(`  error    : ${String(errorFrame.message ?? "").slice(0, 200)}`);
  console.log(`  reply[0..200]: ${reply.slice(0, 200).replace(/\r?\n/g, "\\n")}`);
  console.log(`  criteria : ${kase.why}`);
  console.log(`  result   : ${passed ? "PASS" : "FAIL"}`);
  console.log("");
  return passed;
}

const apiKey = readApiKey();
console.log(`live-matrix -> ${ORIGIN}`);
console.log(`key         : redacted (${apiKey.length} chars read from .dev.vars)`);
console.log(`timeout     : ${TIMEOUT_MS}ms per probe\n`);

let allPass = true;
for (const kase of CASES) {
  const ok = await runCase(kase, apiKey);
  if (!ok) allPass = false;
}

console.log(allPass ? "OVERALL: PASS (4/4)" : "OVERALL: FAIL");
process.exit(allPass ? 0 : 1);
