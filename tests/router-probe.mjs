// tests/router-probe.mjs - live capability matrix for the router's model ids.
//
// WHAT THIS ANSWERS, and why production is dead without it. Both MODEL_PRIMARY and
// MODEL_CHEAP are currently configured as a cloudflare-ai catalog id that the live router
// rejects, so /api/decide 500s and no later task can be tested against it. Two separate
// properties are needed by the agent loop the rest of this plan builds, and they are
// independent: (a) the id answers a TOOL CALL at all, and (b) the response STREAMS. An id can
// pass one and fail the other, because a tool call that only exists in a final aggregated body
// field never reaches a delta reader. This script measures both per id, plus whether the round
// trip survives a continuation turn, which is what a multi-step loop actually requires.
// Recorded results: docs/explorations/router-capability-probe.md.
//
// This script decides MODEL_PRIMARY and MODEL_CHEAP. It is a LIVE script: it makes no network
// call unless you run it, and `npm test` never runs it (tests/run-all.mjs matches
// tests/*.test.mjs only, and this file is not one).
//
// USAGE (run it from the deploy tree, where wrangler.jsonc holds the live tunnel URL and
// .dev.vars holds the keys; from repo-clone pass VAR_DIR, since the tunnel URL and the keys
// are deliberately absent from repo-clone):
//   node tests/router-probe.mjs gemini3.7flash opus5 gemini3.8flash opus5thinking \
//     z-ai/glm-5.1 moonshotai/kimi-k2.6 deepseek-ai/deepseek-v4-pro qmodel_latest
//
// INPUTS, all read at runtime and NEVER printed or committed:
//   arg 2..     model ids to probe. Nothing is probed unless you name it, so a stray run
//               cannot spend money or hit the wrong host.
//   env BLIP_ROUTER_URL   chat-completions base. Default: vars.ROUTER_URL of the wrangler.jsonc
//               next to this file. That value is a rotating cloudflared quick tunnel, so it
//               dies; pass the current one explicitly when it does. An origin, a /v1 prefix or
//               the full /v1/chat/completions path are all accepted, and none of them can
//               produce a doubled path.
//   env VAR_DIR           directory holding .dev.vars (default: the tree of this file). The
//               deploy tree is not a git repo, so that is where the live secrets live.
//   env ROUTER_KEY        key for the router. Default: ROUTER_KEY in <VAR_DIR>/.dev.vars, then
//               authKeys[0] of <VAR_DIR>/deploy/router-worker/router-config.json. Note that
//               .dev.vars ROUTER_URL points at 127.0.0.1, for wrangler dev: the public tunnel
//               comes from wrangler.jsonc, not from there.
//   env BLIP_URL + AGENT_API_KEY   a deployed BLIP origin and its key, for the baseline rows
//               that show what the currently configured ids do through the worker. Skipped
//               when either is missing.
//
// PROPER SOLUTION, what each phase proves:
//   baseline   POST <agent>/api/decide     -> the CURRENT production shape, informational.
//   tool       POST <base> stream:false    -> (a) it answered a tool call, in the OpenAI shape:
//              choices[0].message.tool_calls[0].function.name === "echo_probe".
//   stream     same call with stream:true  -> (b) it streamed: HTTP 200, content-type
//              text/event-stream, >=3 `data:` events, and tool-call argument fragments that
//              reassemble into valid JSON across chunks. `text` means it streamed prose but put
//              no tool call in the deltas, which is a different thing and recorded separately.
//   deltas     tool call with stream_options.include_only_deltas = true
//              -> whether that switch changes the shape. Recorded per id, because for some ids
//              it does, and Task 3 builds the provider path that would send it.
//   toolseen   the model's own tool call sent back in history plus a tool result
//              -> the round trip works. A model that cannot read its own tool call back cannot
//              run a multi-step loop, whatever its first turn did.
//
// There is no separate phase for a catalog-form id (an entry id with the upstream id appended).
// Pass such an id on argv: the tool phase reports its http status and the router's own error
// reason, which is how the double-prefix question gets answered before code depends on it.
//
// PASS RULE. BOTH-PASS, the brief's rule and the bar for naming a model id at all: `tool` ok
// AND `stream` ok. LOOP-READY adds `toolseen` ok, and that is the bar for choosing between two
// BOTH-PASS ids, because the loop is what Phase 2 builds. `deltas` is reported but is not part
// of either rule: BLIP controls whether it sends that switch. Metering is printed in the note
// and never used as a silent filter - if an id only works by spending credits that belongs in
// the table for the user to weigh, not in a default this script picks quietly.
//
// SECRETS. Redaction is done HERE, at the moment a value could be printed, and it is
// unconditional: hostnames, header values, error bodies and message text all pass through
// red(). No secret literal is stored in this file, so none can leak into a stdout capture or a
// committed doc the way a hardcoded token would.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A bare relative "../.dev.vars" resolves against process.cwd(), so running this file from
// repo-clone (no .dev.vars) or from the handoff root would silently probe nothing. Anchor to
// this file's own directory instead, exactly like tests/live-matrix.mjs does.
const TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VAR_DIR = process.env.VAR_DIR ? path.resolve(process.env.VAR_DIR) : TREE;
const HERE = path.join(TREE, "wrangler.jsonc");
const TIMEOUT_MS = 150000; // one deep id can spend minutes reasoning before it emits a byte

// ---------------------------------------------------------------- secret hygiene
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g, // router keys
  /bik_[A-Za-z0-9_-]{8,}/g, // agent api keys
  /(https?:\/\/)[^\s"'\\]+/g, // any URL, which covers the rotating tunnel host
];
function red(v) {
  let s = String(v ?? "");
  for (const re of SECRET_PATTERNS) s = s.replace(re, "[redacted]");
  return s;
}
function headerLine(name, value) {
  return `${name}: ${red(value)}`;
}

// ------------------------------------------------------------------- env reading
function readVarFile(dir) {
  const p = path.join(dir, ".dev.vars");
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, "").trim();
  }
  return out;
}

function readWranglerModelIds(file) {
  if (!fs.existsSync(file)) return {};
  const t = fs.readFileSync(file, "utf8");
  const g = (k) => (t.match(new RegExp(`"${k}"\\s*:\\s*"([^"]+)"`)) || [])[1];
  return { primary: g("MODEL_PRIMARY"), cheap: g("MODEL_CHEAP"), routerUrl: g("ROUTER_URL") };
}

function readRouterKeys(dir) {
  const p = path.join(dir, "deploy", "router-worker", "router-config.json");
  if (!fs.existsSync(p)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(j.authKeys) ? j.authKeys.map(String) : [];
  } catch { return []; }
}

const vars = readVarFile(VAR_DIR);
const w = readWranglerModelIds(HERE);
// .dev.vars ROUTER_URL is a 127.0.0.1 address for wrangler dev, so the public tunnel comes
// from vars.ROUTER_URL in wrangler.jsonc; an operator can still override either with env.
const BASE = (process.env.BLIP_ROUTER_URL || w.routerUrl || "").replace(/\/+$/, "");
// Every key this tree knows about, in order, none of them ever printed. The deployed router
// authenticates against authKeys in its KV config, while .dev.vars can hold a key that only
// the local router accepts, so the run picks whichever one the base URL answers, once, up
// front. See negotiateKey().
const KEYS = [...new Set([
  process.env.ROUTER_KEY || "",
  vars.ROUTER_KEY || "",
  vars.ROUTER_API_KEY || "",
  ...readRouterKeys(VAR_DIR),
])].filter(Boolean);
let KEY = "";
let KEY_INDEX = -1;
const AGENT = (process.env.BLIP_URL || "").replace(/\/+$/, "");
const AGENT_KEY = process.env.AGENT_API_KEY || vars.AGENT_API_KEY || "";
// Some upstreams on this router are free tiers with a per-tier minimum spacing (one answers
// "Rate limit exceeded for your tier (7 seconds between ...)"), and a back-to-back matrix then
// records a rate limit as if it were a capability failure. Space the requests when probing
// those ids: REQ_GAP_MS=8000.
const GAP = Math.max(0, Number(process.env.REQ_GAP_MS || 0) || 0);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// vars.ROUTER_URL in the deploy tree is the FULL endpoint, .../v1/chat/completions, while an
// operator passing BLIP_ROUTER_URL usually passes an origin. Accept either without ever
// producing the doubled path, which is exactly the bug shape this task exists to find.
function chatUrl() {
  if (!BASE) return "";
  if (/\/chat\/completions$/.test(BASE)) return BASE;
  if (/\/v1$/.test(BASE)) return `${BASE}/chat/completions`;
  return `${BASE}/v1/chat/completions`;
}

// -------------------------------------------------------------------- http layer
async function post(url, body, key, mode) {
  if (GAP) await wait(GAP);
  const headers = {
    "content-type": "application/json",
    accept: mode === "stream" ? "text/event-stream" : "application/json",
    authorization: `Bearer ${key}`,
  };
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((e) => ({ error: e && e.message ? e.message : String(e) }));
  if (res.error) {
    // same shape as a real response, so a transport failure prints a row instead of crashing
    return {
      error: red(res.error), status: 0, ct: "", conn: "", ms: Date.now() - t0,
      events: 0, text: "", names: [], argChunks: [], sawUsage: false, sawFinish: false,
      json: null, body: String(res.error),
    };
  }

  if (mode === "stream") {
    const ct = res.headers.get("content-type") || "";
    const raw = await res.text().catch((e) => "");
    const lines = String(raw).split(/\r?\n/).filter((l) => l.startsWith("data:"));
    let text = "";
    let names = [];
    let argChunks = [];
    let sawUsage = false;
    let sawFinish = false;
    for (const l of lines) {
      const payload = l.slice(5).trim();
      if (payload === "[DONE]") continue;
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      if (j.usage) sawUsage = true;
      if (j.done === true) sawFinish = true;
      const choice = (j.choices || [])[0] || {};
      const delta = choice.delta || {};
      if (typeof delta.content === "string") text += delta.content;
      for (const tc of delta.tool_calls || []) {
        if (tc.function && tc.function.name) names.push(tc.function.name);
        if (tc.function && typeof tc.function.arguments === "string") argChunks.push(tc.function.arguments);
      }
    }
    return {
      status: res.status,
      ct: red(ct),
      ms: Date.now() - t0,
      events: lines.length,
      text,
      names,
      argChunks,
      sawUsage,
      sawFinish,
      body: String(raw).slice(0, 400),
    };
  }
  const raw = await res.text().catch((e) => "");
  let json = null;
  try { json = JSON.parse(raw); } catch { /* non-json error page */ }
  return {
    status: res.status,
    ct: red(res.headers.get("content-type") || ""),
    conn: res.headers.get("x-router-conn") || "",
    ms: Date.now() - t0,
    json,
    meter: meterOf(json, res.headers),
    body: String(raw).slice(0, 400),
  };
}

// What a call cost, as far as anything in this stack reports it: a usage object, any top-level
// body field that looks like billing, and any response header that looks like billing. Printed
// as key names and numbers only, because "cheap must actually be cheaper" needs a number.
function meterOf(json, headers) {
  const parts = [];
  if (json && json.usage && typeof json.usage === "object") {
    parts.push("usage " + Object.keys(json.usage).map((k) => `${k}=${json.usage[k]}`).join(","));
  }
  if (json) {
    for (const k of Object.keys(json)) {
      if (/cost|credit|price|bill|charge/i.test(k)) parts.push(`${k}=${JSON.stringify(json[k]).slice(0, 60)}`);
    }
  }
  const hv = [];
  headers.forEach((v, k) => { if (/cost|credit|price|bill|charge/i.test(k)) hv.push(`${k}=${red(v).slice(0, 40)}`); });
  if (hv.length) parts.push("headers " + hv.join(","));
  return parts.length ? parts.join(" | ") : "no usage or billing field in the response";
}

function shapeOf(json) {
  if (!json) return "no-json";
  if (json.error) return `error:${red((json.error && (json.error.reason || json.error.code || json.error.message)) || "?")}`;
  const c = (json.choices || [])[0];
  if (c && (c.message || c.delta)) return "choices";
  if (Array.isArray(json.output)) return "output-only";
  return "unknown";
}

function toolCallsOf(json) {
  if (!json) return [];
  const c = (json.choices || [])[0];
  if (c && Array.isArray(c.message && c.message.tool_calls)) return c.message.tool_calls;
  // fallback for a body that reports the call in an `output` array instead of `choices`. None of
  // the ids measured here produced that shape; it is kept because a connection on an Anthropic
  // style upstream can, and a silent miss here would read as "this id cannot tool-call".
  for (const item of json.output || []) {
    if (item && item.type === "function_call") {
      return [{ function: { name: item.name, arguments: item.arguments } }];
    }
  }
  return [];
}

function textOf(json) {
  if (!json) return "";
  const c = (json.choices || [])[0];
  if (c && c.message && typeof c.message.content === "string") return c.message.content;
  let out = "";
  for (const item of json.output || []) {
    if (item && item.type === "message") for (const p of item.content || []) if (p && p.text) out += p.text;
  }
  return out;
}

// ------------------------------------------------------------------- the prompts
const TOOL = [{
  type: "function",
  function: {
    name: "echo_probe",
    description: "Echo the given text back verbatim. Use this tool for the task.",
    parameters: { type: "object", properties: { text: { type: "string", description: "text to echo" } }, required: ["text"] },
  },
}];
const ASK = "Call the echo_probe tool with text set to ROUTER-PROBE-OK. Do not answer in prose.";
const ECHOED = "ROUTER-PROBE-OK";

function toolBody(model, extra) {
  return Object.assign({ model, messages: [{ role: "user", content: ASK }], tools: TOOL, tool_choice: "auto", stream: false }, extra || {});
}
// The same turn one step later: the assistant's own tool call, then a tool result. A model
// that cannot read this back cannot run an agent loop, no matter what its first turn does.
// The call is replayed EXACTLY as it came back, extra fields included, because Google requires
// a thought_signature on a functionCall part and a rebuilt object without one is rejected:
// rebuilding here would measure the replay shape instead of the model.
function roundTripBody(model, call) {
  const c = { ...call };
  if (!c.id) c.id = "call_probe_1";
  if (!c.type) c.type = "function";
  const name = c.function && c.function.name ? c.function.name : "echo_probe";
  return {
    model,
    messages: [
      { role: "user", content: ASK },
      { role: "assistant", content: null, tool_calls: [c] },
      { role: "tool", tool_call_id: c.id, content: JSON.stringify({ echoed: name === "echo_probe" ? ECHOED : null }) },
      // and then a turn that can only be answered from the tool result. Without it a model that
      // obeyed "do not answer in prose" returns an EMPTY assistant message (measured: finish_reason
      // stop, no content, no tool_calls), which is a valid completion and proves nothing about
      // whether the tool output was read.
      // R-D amendment, measured: gemini3.7flash answered the first version of this turn with an
      // EMPTY message plus 1 new tool_call, i.e. it re-called the tool instead of reading its own
      // result. Make the "answer from the tool result, do not call again" demand unambiguous so
      // toolseen measures the round trip rather than the phrasing.
      { role: "user", content: `The tool call above returned a result. Answer only from that tool result: reply with the exact value of its "echoed" field and nothing else. Do not call any tool again.` },
    ],
    tools: TOOL,
    tool_choice: "auto",
    stream: false,
  };
}

const FAIL = "FAIL";
function note(reason, extra) {
  return extra ? `${reason}; ${extra}` : reason;
}

// ------------------------------------------------------------------ one candidate
async function probeOne(model, emitRow) {
  // each row is printed the moment its request returns: one deep id can think for minutes, and
  // an operator watching a partial run needs the rows that already exist
  const push = (r) => emitRow([model, ...r]);
  const url = chatUrl();

  // 1. non-stream tool call, the plain OpenAI shape
  const tool = await post(url, toolBody(model), KEY, "json");
  const tcalls = toolCallsOf(tool.json);
  const tcall = tcalls[0];
  const tname = tcall && tcall.function ? tcall.function.name : "";
  const targs = tcall && tcall.function ? String(tcall.function.arguments || "") : "";
  const toolOk = tool.status === 200 && tname === "echo_probe";
  push(["tool", toolOk ? "ok" : FAIL, tool.status, tool.ms,
    shapeOf(tool.json),
    note(toolOk
      ? `function named echo_probe, args ${red(targs.slice(0, 60)) || "empty"}`
      : (tool.status === 200 ? "no tool_call for echo_probe" : "rejected") + `, body ${red((tool.body || "").replace(/\s+/g, " ").slice(0, 140))}`,
    `conn ${red(String(tool.conn).slice(0, 48)) || "none"}, ${tool.meter}`)]);

  // 2. streamed, the OpenAI chat.completion.chunk shape. Pass = 200, content-type
  // text/event-stream, >=3 data: events, and the streamed tool_call fragments reassemble into
  // valid JSON. A text-only stream is reported as `text`, never as ok, because the brief's
  // stream criterion is about a tool call surviving the delta path.
  const stream = await post(url, Object.assign({}, toolBody(model), { stream: true }), KEY, "stream");
  const joined = stream.argChunks.join("");
  let parsed = null;
  let streamRes = FAIL;
  const isSse = /text\/event-stream/i.test(stream.ct || "");
  if (stream.status === 200 && isSse && stream.events >= 3) {
    if (stream.argChunks.length && stream.names.length) {
      try { parsed = JSON.parse(joined); streamRes = "ok"; } catch { streamRes = FAIL; }
    } else if ((stream.text || "").trim()) {
      streamRes = "text";
    }
  }
  push(["stream", streamRes, stream.status || "err", stream.ms,
    stream.ct,
    streamRes === FAIL
      ? note(`sse ${isSse ? "yes" : "NO"}`, `events ${stream.events}, chunks ${stream.argChunks.length}, names ${stream.names.length}, text ${stream.text ? "yes" : "no"}, body ${red((stream.body || "").replace(/\s+/g, " ").slice(0, 100))}`)
      : note(`events ${stream.events}, ${streamRes === "ok" ? `tool args reassembled: ${red(joined.slice(0, 60))}` : "text-only stream, no tool delta"}`,
        `chunks ${stream.argChunks.length}, usage ${stream.sawUsage ? "yes" : "no"}, finish ${stream.sawFinish ? "yes" : "no"}`)]);

  // 3. the same tool call with include_only_deltas set, the switch a streaming client is
  // tempted to send. Upstreams disagree about it: this records whether the id survives it.
  const deltas = await post(url, toolBody(model, { stream_options: { include_only_deltas: true } }), KEY, "json");
  const dOk = deltas.status === 200 && toolCallsOf(deltas.json).length > 0;
  push(["deltas", dOk ? "ok" : FAIL, deltas.status || "err", deltas.ms,
    shapeOf(deltas.json),
    dOk
      ? note("include_only_deltas keeps a tool call reachable", `name ${red(toolCallsOf(deltas.json)[0].function.name)}`)
      : note("include_only_deltas breaks the call", `body ${red((deltas.body || "").replace(/\s+/g, " ").slice(0, 140))}`)]);

  // 4. the round trip: the model must read its own tool call back. The call object is replayed
  // VERBATIM, extra provider fields and all, because Google requires a `thought_signature` on a
  // functionCall part: a hand-rebuilt {id,type,function} object is rejected even by an id that
  // answered the tool call happily one turn earlier, and that rejection is about the replay
  // shape, not the model. Rebuilding by hand would record a false FAIL here.
  let seen = { status: "err", ok: false, note: note("skipped", "no tool call in phase 1") };
  if (tcall) {
    const second = await post(url, roundTripBody(model, tcall), KEY, "json");
    const txt = (textOf(second.json) || "").toLowerCase();
    const ok = second.status === 200 && txt.includes(ECHOED.toLowerCase());
    seen = {
      status: second.status || "err",
      ok,
      note: ok
        ? note("tool result read, echoed value back")
        : note(`second turn did not return the echo (http ${second.status})`,
          `replayed keys ${Object.keys(tcall).join("+")}, second-turn content ${txt ? "present, not the echo" : "EMPTY"}, second-turn tool_calls ${toolCallsOf(second.json).length}, body ${red((second.body || "").replace(/\s+/g, " ").slice(0, 140))}`),
    };
  }
  push(["toolseen", seen.ok ? "ok" : FAIL, seen.status, "", "round-trip", seen.note]);
}

// ---------------------------------------------------------------------- baseline
// src/index.ts:133-199: the deployed /api/decide takes {"context": "..."} and ignores any
// `model` field, always sending vars.MODEL_CHEAP with X-Tier: cheap. So these rows can only
// show what production does right now with the ids it is configured with, not a per-id
// comparison. That is the point: they are the record that production is broken.
async function baseline(emitRow) {
  if (!AGENT || !AGENT_KEY) return;
  const r = await post(`${AGENT}/api/decide`, { context: "I am searching the web for flight times." }, AGENT_KEY, "json");
  const j = r.json || {};
  emitRow(["agent", "decide", j.state && !j.error ? "ok" : FAIL, r.status || "err", r.ms, `state=${red(j.state || "-")}`,
    note(j.error ? `error: ${red(String(j.error).replace(/\s+/g, " ").slice(0, 200))}` : "classified, no error field",
      "this endpoint sends vars.MODEL_CHEAP and ignores the model field (src/index.ts:133-199)")]);
}

// ---------------------------------------------------------------- the auth step
// Pick the key the base URL actually accepts, once, before any real probe. It asks with an id
// that cannot exist: a 401 means the key is wrong and the next one is tried, and any other
// status (a 404 for the unknown id) means auth passed and nothing was spent. Without this a
// stale local key turns the whole matrix into a column of 401s that looks like a model verdict.
async function negotiateKey() {
  for (let i = 0; i < KEYS.length; i++) {
    const r = await post(chatUrl(), { model: "probe-auth-check-nonexistent", messages: [{ role: "user", content: "ping" }], stream: false }, KEYS[i], "json");
    if (r.status === 401 || r.status === 403 || r.status === 0) continue;
    KEY = KEYS[i];
    KEY_INDEX = i;
    return `key #${i} of ${KEYS.length} accepted (http ${r.status} on an unknown id, value redacted)`;
  }
  return `no key accepted: tried ${KEYS.length} (every one answered 401/403). Refusing to report a capability matrix built on rejected auth.`;
}

// -------------------------------------------------------------------------- main
const ids = process.argv.slice(2);
if (!BASE || !KEYS.length || !ids.length) {
  console.log("FATAL: refusing to run without a base URL, a key and at least one model id.");
  console.log(`  base url set    : ${BASE ? "yes (redacted)" : "NO"}`);
  console.log(`  keys available  : ${KEYS.length}`);
  console.log(`  model ids given : ${ids.length}`);
  console.log("  env BLIP_ROUTER_URL, env ROUTER_KEY or VAR_DIR/.dev.vars, and ids on argv.");
  process.exit(2);
}

const auth = await negotiateKey();
console.log(`router-probe -> ${red(BASE)}`);
console.log(`auth         : ${auth}`);
if (!KEY) process.exit(3);
console.log(`var dir      : ${red(VAR_DIR)}`);
console.log(`configured   : MODEL_PRIMARY=${w.primary || "-"} MODEL_CHEAP=${w.cheap || "-"} (ids are config, not secrets)`);
console.log(`ids          : ${ids.join(" ")}`);
console.log(`timeout      : ${TIMEOUT_MS}ms per request`);
console.log("");

const all = [];
function emit(row) {
  all.push(row);
  // printed as it happens: one deep id can think for minutes, and an operator watching a
  // partial run needs the rows that already exist
  console.log(row.join(" | "));
}
await baseline(emit);
for (const id of ids) {
  console.log(`--- ${id} start`);
  await probeOne(id, emit);
  console.log(`--- ${id} done`);
}

console.log("");
console.log("id | phase | result | http | ms | shape/content-type | note");
for (const r of all) console.log(r.join(" | "));

// The decision table the doc transcribes: BOTH-PASS is tool ok AND stream ok AND round trip ok.
const byId = new Map();
for (const [id, phase, ok] of all) {
  if (!ids.includes(id)) continue;
  if (!byId.has(id)) byId.set(id, {});
  byId.get(id)[phase] = ok;
}
console.log("");
console.log("decision table. BOTH-PASS (the brief rule) = tool ok AND stream ok.");
console.log("LOOP-READY = BOTH-PASS AND the round trip (toolseen) is ok, the bar an agent loop");
console.log("actually needs. stream=text means it streamed prose but put no tool call in the deltas.");
for (const id of ids) {
  const p = byId.get(id) || {};
  const both = p.tool === "ok" && p.stream === "ok";
  const loop = both && p.toolseen === "ok";
  console.log(`  ${id} | tool=${p.tool || "-"} | stream=${p.stream || "-"} | deltas=${p.deltas || "-"} | round-trip=${p.toolseen || "-"} | BOTH-PASS=${both ? "YES" : "no"} | LOOP-READY=${loop ? "YES" : "no"}`);
}
