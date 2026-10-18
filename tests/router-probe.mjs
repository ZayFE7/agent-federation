// tests/router-probe.mjs - live capability matrix for the router's model ids.
//
// WHICH LAYER THIS MEASURES. There are two routers in this stack and they are not the same
// program, so a row printed here is a statement about ONE of them:
//   - MEASURED LAYER = the local omniroute. The base URL comes from BLIP_ROUTER_URL, which the
//     deploy tree's .dev.vars sets to a 127.0.0.1 origin with a 3304-entry catalog. This script
//     can reach that layer offline and nothing else; every "the router says" below means omniroute.
//   - NOT MEASURED = production's LLM path, which goes through the `ROUTER` service binding to
//     the `zay-router` Worker. That Worker runs its own resolve() over aliases, combos,
//     connection prefixes and defaultModel and does no OpenAI/Anthropic body translation. An id
//     can be routable on one layer and 404 on the other; that is not a new problem, it is
//     documented in docs/explorations/live-test-report.md section 5.2 ("Two routers, mismatched
//     catalogs"), which this script cites instead of re-deriving it.
//
// WHAT THIS ANSWERS, and why the loop plan stalls without it. Both MODEL_PRIMARY and MODEL_CHEAP
// were configured as a cloudflare-ai catalog id (`cf/@cf/qwen/qwen3.8-27b`) that the zay-router
// Worker answers 404 "not routable" while the local omniroute can serve it (live-test-report.md
// section 5.2), so /api/decide 500d and no later task could be tested against production. Two
// separate properties are needed by the agent loop the rest of this plan builds, and they are
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
//   env BLIP_ROUTER_URL   chat-completions base for the LOCAL omniroute. Default: vars.ROUTER_URL
//               of the wrangler.jsonc next to this file, which in the deploy tree is the
//               rotating cloudflared quick tunnel to an omniroute instance; that tunnel is dead
//               now and it is no longer production's path either (see the baseline note below),
//               so pass BLIP_ROUTER_URL from .dev.vars. An origin, a /v1 prefix or
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
//   baseline   POST <agent>/api/decide     -> the CURRENT production shape, informational. It
//              rides the ROUTER service binding (zay-router), so it is the one row that does NOT
//              measure the local omniroute, and it is skipped whenever the worker is unreachable.
//   tool       POST <base> stream:false    -> (a) it answered a tool call, in the OpenAI shape:
//              choices[0].message.tool_calls[0].function.name === "echo_probe".
//   stream     same call with stream:true  -> (b) it streamed: HTTP 200, content-type
//              text/event-stream, >=3 `data:` events, and tool-call argument fragments that
//              reassemble into valid JSON across chunks. `text` means it streamed prose but put
//              no tool call in the deltas, which is a different thing and recorded separately.
//   deltas     tool call with stream_options.include_only_deltas = true
//              -> whether that switch changes the shape. Recorded per id, because for some ids
//              it does, and Task 3 builds the provider path that would send it.
//   toolseen   the model's own tool call sent back in history plus a tool result carrying a
//              per-run nonce, then a final turn only answerable from that nonce
//              -> the round trip works. A model that cannot read its own tool call back cannot
//              run a multi-step loop, whatever its first turn did.
//
// There is no separate phase for a catalog-form id (an entry id with the upstream id appended).
// Pass such an id on argv: the tool phase reports its http status and the router's own error
// reason, which is how the double-prefix question gets answered before code depends on it.
//
// PASS RULE. BOTH-PASS, the brief's rule and the bar for naming a model id at all: `tool` ok
// AND `stream` ok. LOOP-READY adds `toolseen` ok, and that is the bar for choosing between two
// BOTH-PASS ids, because the loop is what Phase 2 builds. `toolseen` passes only when the second
// turn's text contains the per-run NONCE (a value the script generates for this invocation and
// puts in the TOOL RESULT ONLY, so it exists nowhere earlier in the transcript and cannot be
// parroted) AND that turn's tool_calls length is exactly 0 (re-calling the tool instead of
// reading its result is a loop hazard, not a round trip). Both clauses are load-bearing: the
// pre-nonce rule scored a model that echoed the token it had emitted one turn earlier as
// LOOP-READY. `deltas` is reported but is not part of either rule: BLIP controls whether it
// sends that switch. Metering is printed in the note and never used as a silent filter - if an
// id only works by spending credits that belongs in the table for the user to weigh, not in a
// default this script picks quietly.
//
// SECRETS. Redaction is done HERE, at the moment a value could be printed, and it is
// unconditional: hostnames, header values, error bodies and message text all pass through
// red(). No secret literal is stored in this file, so none can leak into a stdout capture or a
// committed doc the way a hardcoded token would. red() covers the classes that can actually
// reach a row: key values, uuid-shaped tokens (provider ids like `anthropic-compatible-<uuid>`),
// scheme-less host-like tokens (a tunnel hostname arrives without its scheme in some error
// bodies), plus every identifier this machine's router config exposes as a personal value -
// connection `prefix` values, the `label` and `provider` of any non-builtin connection, the
// `aliasProviders` keys and values, and the auth keys themselves. A builtin row's label and
// provider are the public catalog name and are left readable. Those literals are read at runtime
// and only ever used as replacement targets: no match, count or example of them is printed.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// A bare relative "../.dev.vars" resolves against process.cwd(), so running this file from
// repo-clone (no .dev.vars) or from the handoff root would silently probe nothing. Anchor to
// this file's own directory instead, exactly like tests/live-matrix.mjs does.
const TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VAR_DIR = process.env.VAR_DIR ? path.resolve(process.env.VAR_DIR) : TREE;
const HERE = path.join(TREE, "wrangler.jsonc");
const TIMEOUT_MS = 150000; // one deep id can spend minutes reasoning before it emits a byte

// ---------------------------------------------------------------- secret hygiene
// The value classes that can actually reach a printed row. A row prints header values, upstream
// error bodies and model text, so every one of them is untrusted input:
//   * key values, with and without a known prefix (the literals themselves are added below);
//   * uuid-shaped tokens, which is how a connection's provider id is spelled here;
//   * a scheme-less host: some error bodies carry the tunnel or origin without its "https://"
//     head, where the URL pattern above cannot see it;
//   * personal identifiers read out of this machine's router config, matched as literals.
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g, // router keys
  /bik_[A-Za-z0-9_-]{8,}/g, // agent api keys
  /(https?:\/\/)[^\s"'\\]+/g, // any URL, which covers the rotating tunnel host
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // uuid-shaped ids
  /\b[0-9a-f]{8,}-[0-9a-f-]{3,}\b/gi, // uuid-ish ids truncated by a body slice
  /\b[^\s"'\\/]*trycloudflare[^\s"'\\]*/gi, // tunnel hosts, scheme or no scheme
  // a bare host-like token: labels, then a dotted TLD-looking tail, then an optional path
  /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|dev|io|ai|app|cloud|run|live|site|works|xyz|page|tech|club|online|store|info|biz|me|co|in|de|fr|ru|cn|jp|uk|nl|top)\b(?:\/[^\s"'\\]*)?/gi,
];

// Identifier fields of the router config that name a personal connection rather than a public
// catalog entry: a conn `label`, its `prefix`, the aliasProvider table, the `provider` id of any
// non-builtin connection, and the auth keys. A builtin connection's label and provider are the
// public catalog name (extract-config.py sets label = provider for those rows), so they are left
// readable: `nvidia` or `gemini` in a row is a fact about the upstream, not about an account.
function personalLiterals(cfg, keys) {
  const out = new Set();
  const add = (v) => {
    const s = String(v ?? "").trim();
    if (s.length >= 2 && s.length <= 200) out.add(s);
  };
  for (const k of keys) add(k);
  for (const c of (cfg && Array.isArray(cfg.connections)) ? cfg.connections : []) {
    if (!c || typeof c !== "object") continue;
    add(c.prefix);
    if (c.type !== "builtin") { add(c.label); add(c.provider); }
  }
  const ap = (cfg && cfg.aliasProviders) || {};
  for (const [k, v] of Object.entries(ap)) { add(k); add(v); }
  return [...out].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

const escBoundary = "(?<![A-Za-z0-9_-])(?:%L)(?![A-Za-z0-9_-])";

function buildRedactor(literals) {
  const res = SECRET_PATTERNS.slice();
  if (literals.length) res.push(new RegExp(escBoundary.replace("%L", literals.join("|")), "gi"));
  return (v) => {
    let s = String(v ?? "");
    for (const re of res) s = s.replace(re, "[redacted]");
    return s;
  };
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

function readRouterConfig(dir) {
  const p = path.join(dir, "deploy", "router-worker", "router-config.json");
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return j && typeof j === "object" ? j : null;
  } catch { return null; }
}

// Parsed once, then used two ways and never printed: authKeys feed the key list below, the
// identifier fields feed the redactor. Absent config (repo-clone, a fresh clone) only means the
// literal list is empty; the generic patterns still apply.
const ROUTER_CFG = readRouterConfig(VAR_DIR);
function authKeysOf(cfg) {
  return cfg && Array.isArray(cfg.authKeys) ? cfg.authKeys.map(String) : [];
}

const vars = readVarFile(VAR_DIR);
const w = readWranglerModelIds(HERE);
// .dev.vars ROUTER_URL is the 127.0.0.1 origin of the LOCAL omniroute, the layer this script
// measures. wrangler.jsonc's vars.ROUTER_URL is a tunnel to an omniroute instance, not a second
// router, and not production's path either (production uses the ROUTER service binding). An
// operator can override either with BLIP_ROUTER_URL.
const BASE = (process.env.BLIP_ROUTER_URL || w.routerUrl || "").replace(/\/+$/, "");
// Every key this tree knows about, in order, none of them ever printed. The deployed router
// authenticates against authKeys in its KV config, while .dev.vars can hold a key that only
// the local router accepts, so the run picks whichever one the base URL answers, once, up
// front. See negotiateKey().
const KEYS = [...new Set([
  process.env.ROUTER_KEY || "",
  vars.ROUTER_KEY || "",
  vars.ROUTER_API_KEY || "",
  ...authKeysOf(ROUTER_CFG),
])].filter(Boolean);
let KEY = "";
let KEY_INDEX = -1;
const AGENT = (process.env.BLIP_URL || "").replace(/\/+$/, "");
const AGENT_KEY = process.env.AGENT_API_KEY || vars.AGENT_API_KEY || "";

// red() is bound once, after the key list exists, so the keys themselves are among the literals.
// Everything printable goes through it: header values, error bodies, model text, paths.
const red = buildRedactor(personalLiterals(ROUTER_CFG, [...KEYS, AGENT_KEY]));

// The toolseen nonce: one unpredictable value per script invocation, used as the payload of the
// TOOL RESULT and as nothing else. It is not a credential and carries no secret material; it is
// generated with random bytes so a model cannot guess it and a rerun cannot reuse it. The point
// is that it exists in no earlier turn: the token the ASK string makes the model emit is
// reproducible by parroting, which is exactly the unsound criterion this replaces.
const NONCE = `probe-${crypto.randomBytes(8).toString("hex")}`;
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
      finish: "", meter: "no response reached, so no usage or billing field either",
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
    const finishReasons = [];
    for (const l of lines) {
      const payload = l.slice(5).trim();
      if (payload === "[DONE]") continue;
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      if (j.usage) sawUsage = true;
      if (j.done === true) sawFinish = true;
      const choice = (j.choices || [])[0] || {};
      if (typeof choice.finish_reason === "string") finishReasons.push(choice.finish_reason);
      const delta = choice.delta || {};
      if (typeof delta.content === "string") text += delta.content;
      for (const tc of delta.tool_calls || []) {
        if (tc.function?.name) names.push(tc.function.name);
        if (typeof tc.function?.arguments === "string") argChunks.push(tc.function.arguments);
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
      // the streamed turn's own finish_reason, last one wins; empty when the upstream never sent
      // one, which is a different fact from `stop` and is printed as such.
      finish: finishReasons.length ? finishReasons[finishReasons.length - 1] : "",
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
    finish: finishOf(json),
    meter: meterOf(json, res.headers),
    body: String(raw).slice(0, 400),
  };
}

// choices[0].finish_reason of a non-streamed body. Every caller names which turn it belongs to,
// because a first-turn `tool_calls` and a second-turn `stop` mean different things and a row that
// says only "finish=stop" cannot be read back.
function finishOf(json) {
  const c = ((json && json.choices) || [])[0];
  return c && typeof c.finish_reason === "string" ? c.finish_reason : "";
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
// ECHOED is what ASK makes the model emit on turn 1, and the script also supplies it in the tool
// result. It is therefore in the transcript before the round trip is scored, so a second turn that
// contains it proves only that the model can repeat itself. It stays in the payload for body-shape
// continuity with the earlier rounds, but it is NOT a pass signal any more.
const ECHOED = "ROUTER-PROBE-OK";

// A future edit that pasted NONCE into ASK would silently restore the parrotable criterion, so the
// invariant is checked at startup rather than trusted.
if (ASK.includes(NONCE) || ECHOED.includes(NONCE)) {
  console.log("FATAL: the toolseen nonce reached the first turn. toolseen would be parrotable again, refusing to measure that.");
  process.exit(2);
}

function toolResultPayload(name) {
  // The nonce value appears HERE and nowhere else in the conversation: not in ASK, not in the
  // replayed assistant turn, not in the final instruction (which names the field, not the value).
  return JSON.stringify({ echoed: name === "echo_probe" ? ECHOED : null, nonce: NONCE });
}

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
      { role: "tool", tool_call_id: c.id, content: toolResultPayload(name) },
      // and then a turn that can only be answered from the tool result. Without it a model that
      // obeyed "do not answer in prose" returns an EMPTY assistant message (measured on the first
      // round: first-turn finish_reason stop, no content, no tool_calls), which is a valid
      // completion and proves nothing about whether the tool output was read.
      // R-D amendment, measured: gemini3.7flash answered the first version of this turn with an
      // EMPTY message plus 1 new tool_call, i.e. it re-called the tool instead of reading its own
      // result. Make the "answer from the tool result, do not call again" demand unambiguous so
      // toolseen measures the round trip rather than the phrasing.
      // Fix-round-1 amendment (I2): the value it asks for is the nonce, and the pass rule also
      // requires this turn to carry no tool call. Asking by field NAME keeps the nonce itself out
      // of this turn, so the only place a model can have read it from is the tool result.
      { role: "user", content: `The tool call above returned a result. Answer only from that tool result: reply with the exact value of its "nonce" field and nothing else. Do not call any tool again.` },
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

// The toolseen pass rule in one place so it can be tested offline. `text` is the SECOND turn's
// text, `calls` that turn's tool_calls length. Nothing here looks at turn 1: the only signal that
// counts is the nonce, which the script put into the tool result and nowhere else.
function toolseenVerdict(status, text, calls) {
  const low = String(text || "").toLowerCase();
  const hasNonce = low.includes(NONCE.toLowerCase());
  const hasEcho = low.includes(ECHOED.toLowerCase());
  const fails = [];
  if (status !== 200) fails.push(`http ${status}`);
  if (!hasNonce) fails.push("second-turn text does not carry the tool-result nonce");
  if (calls !== 0) fails.push(`second turn re-called the tool (${calls} tool_calls)`);
  return { ok: fails.length === 0, hasNonce, hasEcho, fails };
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
    `first-turn finish_reason=${red(tool.finish) || "absent"}, conn ${red(String(tool.conn).slice(0, 48)) || "none"}, ${tool.meter}`)]);

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
      : note(`events ${stream.events}, ${streamRes === "ok"
          // `parsed` is the reassembled arguments object; the key names are what makes this row
          // checkable by a reader, the raw string alone could be any fragment.
          ? `tool args reassembled into valid JSON, keys ${red(Object.keys(parsed).join("+") || "none")}: ${red(joined.slice(0, 60))}`
          : "text-only stream, no tool delta"}`,
        `chunks ${stream.argChunks.length}, streamed-turn usage ${stream.sawUsage ? "yes" : "no"}, streamed-turn finish_reason=${stream.finish || "absent"}, streamed-turn done marker ${stream.sawFinish ? "yes" : "no"}`)]);

  // 3. the same tool call with include_only_deltas set, the switch a streaming client is
  // tempted to send. Upstreams disagree about it: this records whether the id survives it.
  // The pass rule is the tool phase's rule, name included: a call that arrives under some other
  // function name is not the call this probe asked for, and a malformed chunk must not be able to
  // throw and take the run with it.
  const deltas = await post(url, toolBody(model, { stream_options: { include_only_deltas: true } }), KEY, "json");
  const dCalls = toolCallsOf(deltas.json);
  const dName = dCalls[0]?.function?.name || "";
  const dOk = deltas.status === 200 && dCalls.length > 0 && dName === "echo_probe";
  push(["deltas", dOk ? "ok" : FAIL, deltas.status || "err", deltas.ms,
    shapeOf(deltas.json),
    dOk
      ? note("include_only_deltas keeps a tool call named echo_probe",
        `name ${red(dName)}, first-turn finish_reason=${red(deltas.finish) || "absent"}`)
      : note(`include_only_deltas leaves no echo_probe call (http ${deltas.status || "err"}, calls ${dCalls.length}, name ${red(dName) || "none"})`,
        `body ${red((deltas.body || "").replace(/\s+/g, " ").slice(0, 140))}`)]);

  // 4. the round trip: the model must read its own tool call back. The call object is replayed
  // VERBATIM, extra provider fields and all, because Google requires a `thought_signature` on a
  // functionCall part: a hand-rebuilt {id,type,function} object is rejected even by an id that
  // answered the tool call happily one turn earlier, and that rejection is about the replay
  // shape, not the model. Rebuilding by hand would record a false FAIL here.
  // Pass rule (fix round 1, I2): see toolseenVerdict. HTTP 200 AND the second turn's text
  // contains the per-run nonce AND that turn's tool_calls length is exactly 0. The nonce exists
  // only in the tool result, so a repeat of turn 1 cannot satisfy it, and a turn that answers
  // correctly while re-calling the tool is a loop hazard, not a round trip, so it no longer
  // scores as one either.
  let seen = { status: "err", ok: false, note: note("skipped", "no tool call in phase 1") };
  if (tcall) {
    const second = await post(url, roundTripBody(model, tcall), KEY, "json");
    const txt = textOf(second.json) || "";
    const secondCalls = toolCallsOf(second.json).length;
    const v = toolseenVerdict(second.status, txt, secondCalls);
    const diag = `replayed keys ${Object.keys(tcall).join("+")}, second-turn content ${txt.trim() ? "present" : "EMPTY"}, second-turn finish_reason=${red(second.finish) || "absent"}, second-turn tool_calls ${secondCalls}, nonce in second-turn text ${v.hasNonce ? "present" : "absent"}, old parrotable signal (turn-1 echo token in second-turn text) ${v.hasEcho ? "present" : "absent"}`;
    seen = {
      status: second.status || "err",
      ok: v.ok,
      note: v.ok
        ? note("nonce read out of the tool result and no new tool call", diag)
        : note(`not a round trip: ${v.fails.join(", ")}`, diag + `, body ${red((second.body || "").replace(/\s+/g, " ").slice(0, 140))}`),
    };
  }
  push(["toolseen", seen.ok ? "ok" : FAIL, seen.status, "", "round-trip", seen.note]);
}

// ---------------------------------------------------------------------- baseline
// The deployed /api/decide takes {"context": "..."}, ignores any `model` field in the body, and
// sends vars.MODEL_CHEAP through fetchRouter, which prefers the ROUTER service binding to the
// zay-router Worker. It sets no tier header: X-Tier was deleted in e85d0c3 (Task 3) because the
// router never read it. So these rows can only show what production does right now with the ids it
// is configured with, on the OTHER router layer, not a per-id comparison against the local
// omniroute. That is the point: they are the record of what production actually answers.
async function baseline(emitRow) {
  if (!AGENT || !AGENT_KEY) return;
  const r = await post(`${AGENT}/api/decide`, { context: "I am searching the web for flight times." }, AGENT_KEY, "json");
  const j = r.json || {};
  emitRow(["agent", "decide", j.state && !j.error ? "ok" : FAIL, r.status || "err", r.ms, `state=${red(j.state || "-")}`,
    note(j.error ? `error: ${red(String(j.error).replace(/\s+/g, " ").slice(0, 200))}` : "classified, no error field",
      "this endpoint sends vars.MODEL_CHEAP over the ROUTER binding and ignores the model field (src/index.ts, the api/decide branch)")]);
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

// ---------------------------------------------------------------- offline self-test
// `node tests/router-probe.mjs --selftest` checks the two instruments this script prints through,
// with no network and no keys: the toolseen pass rule (it must not be satisfiable by a repeat of
// turn 1, nor by a turn that re-calls the tool) and redaction (it must cover the value classes
// that reached a committed doc once). It is here because a live criterion you cannot test offline
// drifts back into being unsound, and because `npm test` never loads this file.
function selftest() {
  let n = 0;
  const problems = [];
  const check = (name, cond) => { n += 1; if (!cond) problems.push(name); };

  const call = { id: "call_selftest", type: "function", function: { name: "echo_probe", arguments: JSON.stringify({ text: ECHOED }) } };
  const turns = roundTripBody("selftest-model", call).messages;
  const nonceTurns = turns.filter((m) => String(m.content ?? "").includes(NONCE));
  check("the nonce appears in exactly one turn", nonceTurns.length === 1);
  check("that turn is the tool result", nonceTurns.length === 1 && nonceTurns[0].role === "tool");
  check("the ASK turn does not carry the nonce", !String(turns[0].content).includes(NONCE));
  check("the final turn names the field, not the value",
    /"nonce"/.test(turns[3].content) && !turns[3].content.includes(NONCE));
  check("the final turn still forbids re-calling", /do not call any tool again/i.test(turns[3].content));

  check("a repeat of the turn-1 token alone is NOT a pass", !toolseenVerdict(200, ECHOED, 0).ok);
  check("the nonce plus a fresh tool call is NOT a pass", !toolseenVerdict(200, `value is ${NONCE}`, 1).ok);
  check("an answer without the nonce over 200 is NOT a pass", !toolseenVerdict(200, "ROUTER-PROBE-OK and some prose", 0).ok);
  check("the nonce over an error status is NOT a pass", !toolseenVerdict(503, NONCE, 0).ok);
  check("the nonce with no re-call over 200 IS a pass", toolseenVerdict(200, `here: ${NONCE}`, 0).ok);
  check("a case-shifted nonce still counts", toolseenVerdict(200, NONCE.toUpperCase(), 0).ok);

  // Redaction fixtures are assembled at runtime from harmless pieces, so this committed file never
  // contains a literal a leak scan would mistake for a real key, provider id or tunnel host. The
  // domain used is one reserved for documentation, so it cannot point at anything real either.
  const KEYFIX = ["sk", "syntheticvalue123"].join("-");
  const AGENTFIX = ["bik", "syntheticvalue123"].join("_");
  const UUIDFIX = ["0f2c1a3b", "77aa", "4b1e", "9d2c", "1a2b3c4d5e6f"].join("-");
  const UUIDTRUNC = ["87654321", "abcd", "ef01"].join("-");
  const HOSTFIX = ["synthetic-host", "example", "com"].join(".");
  const TUNNELFIX = ["anything", "trycloudflare", "com"].join(".");

  const literals = personalLiterals({
    connections: [
      { label: "Synthetic Relay Account", prefix: "zz", provider: "someprovider", type: "openai" },
      { label: "Builtin Row", prefix: "bi", provider: "z-ai", type: "builtin" },
    ],
    aliasProviders: { qz: `anthropic-compatible-${UUIDFIX}` },
  }, [KEYFIX, "probe-syntheticnonce0"]);
  const r2 = buildRedactor(literals);
  check("a conn label is redacted", !r2("x-router-conn: someprovider/Synthetic Relay Account").includes("Synthetic Relay"));
  check("a conn prefix is redacted", !r2("matched prefix zz here").includes(" zz "));
  check("an aliasProvider key is redacted", !r2("No active credentials for provider: qz").includes("qz"));
  check("a non-builtin provider id is redacted", !r2("dispatched through someprovider").includes("someprovider"));
  check("a builtin provider name stays readable", r2("No active credentials for provider: z-ai").includes("z-ai"));
  check("a builtin row label stays readable", r2("served by the Builtin Row connection").includes("Builtin Row"));
  check("a builtin row prefix is still redacted", !r2("matched prefix bi here").includes(" bi "));
  check("a key value from the config is redacted", !r2(`authorization: Bearer ${KEYFIX}`).includes(KEYFIX));
  const classes = [
    KEYFIX, AGENTFIX,
    `https://${HOSTFIX}/v1/chat/completions`,
    `${HOSTFIX}/v1/chat/completions written without a scheme`,
    [UUIDFIX, "and a truncated one", UUIDTRUNC].join(" "),
    `a host like ${TUNNELFIX} and https://${TUNNELFIX}/path`,
  ].join(" | ");
  const printed = red(classes);
  check("key prefixes are redacted", !printed.includes(KEYFIX) && !printed.includes(AGENTFIX));
  check("scheme-full URLs are redacted", !printed.includes("https://"));
  check("scheme-less hosts are redacted", !printed.includes(HOSTFIX));
  check("uuid-shaped tokens are redacted", !printed.includes(UUIDFIX) && !printed.includes(UUIDTRUNC));
  check("tunnel hosts are redacted", !printed.includes(TUNNELFIX) && !/trycloudflare/i.test(printed));

  return { n, problems };
}

// -------------------------------------------------------------------------- main
const argv = process.argv.slice(2);
if (argv[0] === "--selftest") {
  const t = selftest();
  console.log(`router-probe selftest: ${t.n} checks, ${t.problems.length} problem(s)`);
  for (const p of t.problems) console.log(`  FAIL ${p}`);
  process.exit(t.problems.length ? 1 : 0);
}
const ids = argv;
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
console.log("measured     : the LOCAL omniroute at that base. This is not the zay-router Worker");
console.log("               that production reaches through the ROUTER service binding; an id");
console.log("               passing here says nothing about that layer's resolve(). See");
console.log("               docs/explorations/live-test-report.md section 5.2.");
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

// The decision table the doc transcribes: BOTH-PASS is tool ok AND stream ok; LOOP-READY adds the
// nonce-scored round trip.
const byId = new Map();
for (const [id, phase, ok] of all) {
  if (!ids.includes(id)) continue;
  if (!byId.has(id)) byId.set(id, {});
  byId.get(id)[phase] = ok;
}
console.log("");
console.log("decision table. BOTH-PASS (the brief rule) = tool ok AND stream ok.");
console.log("LOOP-READY = BOTH-PASS AND toolseen ok, where toolseen means the SECOND turn carried");
console.log("the per-run nonce (it was only ever in the tool result) AND made 0 new tool calls:");
console.log("a repeat of turn 1's token cannot pass it. stream=text means it streamed prose but");
console.log("put no tool call in the deltas.");
for (const id of ids) {
  const p = byId.get(id) || {};
  const both = p.tool === "ok" && p.stream === "ok";
  const loop = both && p.toolseen === "ok";
  console.log(`  ${id} | tool=${p.tool || "-"} | stream=${p.stream || "-"} | deltas=${p.deltas || "-"} | round-trip=${p.toolseen || "-"} | BOTH-PASS=${both ? "YES" : "no"} | LOOP-READY=${loop ? "YES" : "no"}`);
}
