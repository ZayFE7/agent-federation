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

// BLIP_ONLY=7,8 runs just those probe ids. Development convenience; the
// default is every probe, and an empty filter must never read as "all passed".
const ONLY = (process.env.BLIP_ONLY || "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);
const want = (id) => ONLY.length === 0 || ONLY.includes(id);

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
    content: "write three short paragraphs about how monarch butterflies migrate to Mexico",
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

// ---- multi-step scenarios (Task 37) ----
//
// The four CASES above are one turn each. These need several turns or a second
// request, so each one owns its sessions and cleans them up with
// `{confirm_body:true}` so a probe does not leave a workspace in KV.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readMessages(sessionId, apiKey, signal) {
  const res = await api(`/api/sessions/${sessionId}/messages`, apiKey, {}, signal);
  const body = await res.json().catch(() => null);
  if (res.status !== 200 || !body || !body.ok || !Array.isArray(body.messages)) {
    throw new Error(`messages: HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body.messages.map((m) => String(m.content ?? "")).join("\n");
}

async function readTurn(sessionId, content, apiKey, signal) {
  const streamId = await submitTurn(sessionId, content, apiKey, signal);
  const got = await readStream(sessionId, streamId, apiKey, signal);
  if (got.error) throw new Error(got.error);
  return got.frames;
}

async function workspaceState(sessionId, apiKey, signal) {
  const res = await api(`/api/sessions/${sessionId}/workspace`, apiKey, {}, signal);
  const body = await res.json().catch(() => null);
  if (res.status !== 200 || !body || !body.ok) {
    throw new Error(`workspace: HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body.workspace || { saved: false };
}

async function cleanupSessions(ids, apiKey) {
  for (const id of ids) {
    try {
      await api(`/api/sessions/${id}`, apiKey, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm_body: true }),
      });
    } catch {
      // Best effort: a stranded probe session is noise, not a verdict.
    }
  }
}

const frameOf = (frames, kind) => frames.find((f) => f.t === kind) || null;
const toolText = (frames) =>
  frames
    .filter((f) => f.t === "tool-result")
    .map((f) => String(f.output ?? ""))
    .join("\n");

const nonceFor = (tag) =>
  `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const SCENARIOS = [
  {
    id: 5,
    label: "session isolation",
    timeoutMs: 120_000,
    why: "session A's marker reaches A's transcript and shell, and session B's transcript and shell never see it",
    async run(apiKey, signal) {
      const nonce = nonceFor("iso");
      const ids = [];
      try {
        const a = await createSession(apiKey, signal);
        ids.push(a);
        const b = await createSession(apiKey, signal);
        ids.push(b);
        const fa = await readTurn(a, `run: echo ${nonce} > iso.txt && cat iso.txt`, apiKey, signal);
        const errA = frameOf(fa, "error");
        if (errA) throw new Error(`A errored: ${String(errA.message ?? "").slice(0, 120)}`);
        const ta = await readMessages(a, apiKey, signal);
        const fb = await readTurn(b, "run: cat iso.txt", apiKey, signal);
        const tb = await readMessages(b, apiKey, signal);
        const bOut = toolText(fb);
        if (!ta.includes(nonce)) throw new Error("A's transcript does not contain its own marker");
        if (tb.includes(nonce)) throw new Error("B's transcript contains A's marker");
        if (bOut.includes(nonce)) throw new Error("B's shell can read A's marker");
        return {
          ok: true,
          detail: `A transcript has the marker; B transcript and shell do not (B cat: ${JSON.stringify(bOut.slice(0, 80))})`,
        };
      } finally {
        await cleanupSessions(ids, apiKey);
      }
    },
  },
  {
    id: 6,
    label: "workspace survives a sandbox kill",
    timeoutMs: 240_000,
    why: "a file saved in A is readable after four newer sessions push the per-session pool past its four-VM cap, so A's VM was evicted (the shipped kill path) and restored from KV",
    async run(apiKey, signal) {
      const nonce = nonceFor("survive");
      const ids = [];
      try {
        const a = await createSession(apiKey, signal);
        ids.push(a);
        const first = await readTurn(a, `run: echo ${nonce} > survive.txt && ls -la survive.txt`, apiKey, signal);
        if (!frameOf(first, "done")) throw new Error("A's first turn did not finish");
        let st = null;
        for (let i = 0; i < 20; i++) {
          await sleep(1500);
          st = await workspaceState(a, apiKey, signal);
          if (st.saved) break;
        }
        if (!st || !st.saved) throw new Error("the turn-end snapshot never landed in the pointer row");
        for (let i = 0; i < 4; i++) {
          const s = await createSession(apiKey, signal);
          ids.push(s);
          const f = await readTurn(s, "run: echo warm > warm.txt", apiKey, signal);
          if (!frameOf(f, "done")) throw new Error(`pool-filler session ${i + 1} did not finish`);
        }
        const back = await readTurn(a, "run: cat survive.txt", apiKey, signal);
        const out = toolText(back);
        if (!out.includes(nonce)) {
          throw new Error(`A lost the marker across eviction: ${JSON.stringify(out.slice(0, 150))}`);
        }
        return {
          ok: true,
          detail: `pointer saved ${st.files} files / ${st.bytes} bytes; after 4 newer sessions A read its marker back`,
        };
      } finally {
        await cleanupSessions(ids, apiKey);
      }
    },
  },
  {
    id: 7,
    label: "skill install never parks",
    timeoutMs: 240_000,
    why: "a model-emitted skill_install completes without an approval frame, so a skill download cannot strand the loop",
    async run(apiKey, signal) {
      const ids = [];
      try {
        const sid = await createSession(apiKey, signal);
        ids.push(sid);
        // The reserved .invalid TLD fails to resolve, so the install changes
        // nothing; the point is that it runs and the turn settles by itself.
        const frames = await readTurn(
          sid,
          "Use the skill_install tool exactly once with url https://example.invalid/skill.zip. Do not use exec, do not use lookup_online, and do not answer with text only.",
          apiKey,
          signal
        );
        const appr = frameOf(frames, "approval");
        if (appr) {
          throw new Error(`skill_install parked for approval: ${JSON.stringify(appr).slice(0, 200)}`);
        }
        const starts = frames.filter((f) => f.t === "tool-start" && f.name === "skill_install");
        const startIds = new Set(starts.map((f) => f.id));
        const results = frames.filter((f) => f.t === "tool-result" && startIds.has(f.id));
        const output = results.map((f) => String(f.output ?? "")).join("\n");
        const error = frameOf(frames, "error");
        const done = frameOf(frames, "done");
        if (error) throw new Error(`turn error: ${String(error.message ?? "").slice(0, 200)}`);
        if (!starts.length) throw new Error("the model did not call skill_install");
        if (!results.length) throw new Error("skill_install has no tool result");
        if (!done) throw new Error("the turn did not settle");
        if (!/skill install failed|installed/i.test(output)) {
          throw new Error(`skill_install output did not name an outcome: ${JSON.stringify(output.slice(0, 200))}`);
        }
        return {
          ok: true,
          detail: `skill_install ran free, result ${JSON.stringify(output.replace(/\s+/g, " ").slice(0, 100))}, turn done`,
        };
      } finally {
        await cleanupSessions(ids, apiKey);
      }
    },
  },
  {
    id: 8,
    label: "delegated sub-agents",
    timeoutMs: 300_000,
    why: "one model reply calls delegate twice and both child reports arrive as results on the parent's stream",
    async run(apiKey, signal) {
      const ids = [];
      try {
        const sid = await createSession(apiKey, signal);
        ids.push(sid);
        const frames = await readTurn(
          sid,
          "Use the delegate tool twice in the same reply: one sub-agent to explain what a Cloudflare Durable Object is in two sentences, and a second sub-agent to explain what a microVM is in two sentences. Do not answer yourself and do not use any other tool.",
          apiKey,
          signal
        );
        const startIds = new Set(
          frames.filter((f) => f.t === "tool-start" && f.name === "delegate").map((f) => f.id)
        );
        const resultIds = new Set(
          frames.filter((f) => f.t === "tool-result" && startIds.has(f.id)).map((f) => f.id)
        );
        if (startIds.size < 2) throw new Error(`delegate calls started: ${startIds.size}`);
        if (resultIds.size < 2) {
          throw new Error(`delegate calls finished: ${resultIds.size} of ${startIds.size}`);
        }
        const reports = [...resultIds].map((id) =>
          String(frames.find((f) => f.t === "tool-result" && f.id === id)?.output ?? "")
        );
        if (!reports.every((r) => /reported:/i.test(r))) {
          throw new Error(
            `a delegate result did not carry a child report; outputs: ${JSON.stringify(reports.map((r) => r.slice(0, 220)))}`
          );
        }
        return {
          ok: true,
          detail: `${startIds.size} delegate calls, ${resultIds.size} reports, first report ${JSON.stringify(reports[0].slice(0, 100))}`,
        };
      } finally {
        await cleanupSessions(ids, apiKey);
      }
    },
  },
  {
    id: 9,
    label: "ten-tool-call build",
    timeoutMs: 300_000,
    why: "one turn makes at least ten exec calls and finishes without a step-limit error",
    async run(apiKey, signal) {
      const ids = [];
      try {
        const sid = await createSession(apiKey, signal);
        ids.push(sid);
        const frames = await readTurn(
          sid,
          "Use the exec tool at least ten times, one call per file, to create /home/user/site/page1.html through /home/user/site/page10.html. Each file should contain its own filename. Do not use run: prefixes and do not stop early. After the tenth file, list the directory with one more exec call.",
          apiKey,
          signal
        );
        const err = frameOf(frames, "error");
        if (err) throw new Error(`turn errored: ${String(err.message ?? "").slice(0, 150)}`);
        const done = frameOf(frames, "done");
        if (!done) throw new Error("no done frame");
        const blob = JSON.stringify(done.reply || "");
        if (/step limit|too many steps|maximum steps|round limit/i.test(blob)) {
          throw new Error("the turn hit a step limit");
        }
        // Each call emits two tool-start frames (input-start plus
        // input-available), so count distinct ids, not frames.
        const execCalls = new Set(
          frames.filter((f) => f.t === "tool-start" && f.name === "exec").map((f) => f.id)
        ).size;
        if (execCalls < 10) throw new Error(`only ${execCalls} exec calls in the turn`);
        return { ok: true, detail: `${execCalls} exec calls in one turn, no step-limit string` };
      } finally {
        await cleanupSessions(ids, apiKey);
      }
    },
  },
];

async function runScenario(scn, apiKey) {
  const started = Date.now();
  const ctl = new AbortController();
  const timeout = scn.timeoutMs || TIMEOUT_MS;
  const timer = setTimeout(() => ctl.abort(), timeout);
  let result;
  try {
    result = await scn.run(apiKey, ctl.signal);
  } catch (err) {
    result = {
      ok: false,
      detail:
        err && err.name === "AbortError"
          ? `timeout after ${timeout}ms`
          : String(err && err.message ? err.message : err),
    };
  } finally {
    clearTimeout(timer);
  }
  const ms = Date.now() - started;
  console.log(`--- [${scn.id}] ${scn.label} ---`);
  console.log(`  status   : ${result.ok ? "PASS" : "FAIL"}  (${ms}ms)`);
  console.log(`  detail   : ${String(result.detail).slice(0, 400)}`);
  console.log(`  criteria : ${scn.why}`);
  console.log("");
  return result.ok;
}

async function runCase(kase, apiKey) {
  const started = Date.now();
  const ctl = new AbortController();
  const timeout = kase.timeoutMs || TIMEOUT_MS;
  const timer = setTimeout(() => ctl.abort(), timeout);
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
        ? `timeout after ${timeout}ms`
        : String(err && err.message ? err.message : err);
  } finally {
    clearTimeout(timer);
    if (sessionId) await cleanupSessions([sessionId], apiKey);
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
console.log(`timeout     : ${TIMEOUT_MS}ms per simple probe (scenarios override it)\n`);

let allPass = true;
let passedCount = 0;
for (const kase of CASES) {
  if (!want(kase.id)) continue;
  const ok = await runCase(kase, apiKey);
  if (ok) passedCount++;
  else allPass = false;
}
for (const scn of SCENARIOS) {
  if (!want(scn.id)) continue;
  const ok = await runScenario(scn, apiKey);
  if (ok) passedCount++;
  else allPass = false;
}

const total = [...CASES, ...SCENARIOS].filter((p) => want(p.id)).length;
if (total === 0) {
  console.error("FATAL: BLIP_ONLY matched no probe ids.");
  process.exit(2);
}
console.log(allPass ? `OVERALL: PASS (${passedCount}/${total})` : `OVERALL: FAIL (${passedCount}/${total})`);
process.exit(allPass ? 0 : 1);
