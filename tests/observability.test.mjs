// Unit tests for src/observability.ts (plan Task 38): the per-turn span contract.
//
// What is pinned here is the two things a production reader depends on: that a turn's
// span carries its session id and its operation id as string attributes, and that
// reporting stays off until a deployment actually configures a key. Plain Node, no
// framework, no worker runtime: run with `node tests/observability.test.mjs`.
// Silent on success (exit 0). Prints every failure and exits 1 otherwise.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  TRACE_HEADER,
  TRACE_SPAN_NAME,
  shouldTrace,
  traceConfigured,
  traceTagsFor,
  tracedTurn,
  turnTracing,
} from "../src/observability.ts";

const failures = [];

function check(name, fn) {
  try {
    return fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------- fixtures ----

const ENV = { AGENT_API_KEY: "configured" };

/** A GET shaped like the console's request; `headers` is the whole variable. */
const requestWith = (headers = {}) =>
  new Request("https://blip.example/api/sessions/abc/stream", { headers });

/**
 * The platform span, faked only where the wrapper touches it. `isTraced` is true so
 * a test can see the attributes a real runtime would have received.
 */
function fakeSpan() {
  const span = {
    isTraced: true,
    attributes: {},
    statuses: [],
    exceptions: [],
    ends: 0,
    setAttributes(next) {
      Object.assign(span.attributes, next);
      return span;
    },
    setStatus(status) {
      span.statuses.push(status);
      return span;
    },
    recordException(exception) {
      span.exceptions.push(exception);
    },
    end() {
      span.ends += 1;
    },
  };
  return span;
}

/** A tracing capability that hands the callback the span above and logs the open. */
function fakeTracing(span) {
  const opened = [];
  return {
    opened,
    startActiveSpan(name, callback) {
      opened.push({ name });
      return callback(span);
    },
  };
}

/**
 * `tracedTurn` writes one line per settled span. That line is the feature, and in
 * this file it is noise: nearly every case below drives a turn, so the file's own
 * stdout is sinked and a case that cares reads the lines back through `captureLogs`.
 * Failures still surface, because the summary at the bottom writes to stderr.
 */
const sink = () => {};
console.log = sink;

/** Record what the module logs until `restore()` puts the sink back. */
function captureLogs() {
  const lines = [];
  console.log = (...args) => lines.push(args.map(String).join(" "));
  return { lines, restore: () => (console.log = sink) };
}

// --------------------------------------------------------- traceTagsFor ------

check("traceTagsFor carries both ids as string values", () => {
  const tags = traceTagsFor("abc", "op1");
  const values = Object.values(tags);
  assert.ok(values.includes("abc"), `sessionId is missing from ${JSON.stringify(tags)}`);
  assert.ok(values.includes("op1"), `operationId is missing from ${JSON.stringify(tags)}`);
});

check("traceTagsFor returns a Record of string keys to string values", () => {
  const tags = traceTagsFor("s-2", "o-2");
  for (const [key, value] of Object.entries(tags)) {
    assert.equal(typeof key, "string", `key ${String(key)} is not a string`);
    assert.equal(typeof value, "string", `value for ${key} is not a string`);
  }
  assert.ok(Object.keys(tags).length >= 2, "both ids need their own attribute key");
});

check("traceTagsFor keys are stable and namespaced so a trace query can name them", () => {
  const first = traceTagsFor("abc", "op1");
  assert.deepEqual(first, traceTagsFor("abc", "op1"), "the key set drifted between calls");
  for (const key of Object.keys(first)) {
    assert.match(key, /^[a-z][a-z0-9._-]+$/, `${key} is not a valid span attribute key`);
  }
});

check("traceTagsFor separates the session key from the operation key", () => {
  const tags = traceTagsFor("abc", "op1");
  const entries = Object.entries(tags);
  const session = entries.find(([, value]) => value === "abc");
  const operation = entries.find(([, value]) => value === "op1");
  assert.ok(session && operation, "each id must be findable on its own");
  assert.notEqual(session[0], operation[0], "one key cannot carry both ids");
});

// ------------------------------------------------------------- shouldTrace ----

check("no X-Blip-Trace header means no trace, so ordinary traffic does not pay", () => {
  assert.equal(shouldTrace(requestWith(), ENV), false);
  assert.equal(shouldTrace(requestWith({ "X-Blip-Other": "1" }), ENV), false);
});

check("X-Blip-Trace: 1 turns tracing on for that request", () => {
  assert.equal(shouldTrace(requestWith({ [TRACE_HEADER]: "1" }), ENV), true);
});

check("the header the brief names is the header the code reads", () => {
  assert.equal(TRACE_HEADER, "X-Blip-Trace");
  assert.equal(shouldTrace(requestWith({ "X-Blip-Trace": "1" }), ENV), true);
});

check("AGENT_API_KEY unset means no tracing, even with the header", () => {
  assert.equal(shouldTrace(requestWith({ [TRACE_HEADER]: "1" }), {}), false);
  assert.equal(shouldTrace(requestWith({ [TRACE_HEADER]: "1" }), { AGENT_API_KEY: "" }), false);
  assert.equal(shouldTrace(requestWith({ [TRACE_HEADER]: "1" }), { AGENT_API_KEY: "   " }), false);
  assert.equal(shouldTrace(requestWith({ [TRACE_HEADER]: "1" })), false);
});

check("a header value that is not the on value does not trace", () => {
  for (const value of ["0", "yes", "", "true"]) {
    assert.equal(
      shouldTrace(requestWith({ [TRACE_HEADER]: value }), ENV),
      false,
      `${JSON.stringify(value)} must not enable tracing`
    );
  }
});

check("traceConfigured is the half that works when a turn has no request", () => {
  assert.equal(traceConfigured(ENV), true);
  assert.equal(traceConfigured({}), false);
  assert.equal(traceConfigured(), false);
});

check("turnTracing gives a turn the capability on exactly the same rule", () => {
  const capability = fakeTracing(fakeSpan());
  assert.equal(turnTracing(ENV, capability), capability, "a configured deployment traces");
  assert.equal(turnTracing({ AGENT_API_KEY: "" }, capability), undefined);
  assert.equal(turnTracing({}, capability), undefined, "no key means no span at all");
});

// ----------------------------------------------------------- tracedTurn ------

await checkAsync("a turn with no tracing capability still runs and returns its value", async () => {
  let ran = 0;
  const result = await tracedTurn({
    agent: "FederationAgent",
    sessionId: "abc",
    operationId: "op1",
    run: async () => {
      ran += 1;
      return "reply";
    },
  });
  assert.equal(result, "reply");
  assert.equal(ran, 1, "the body must run exactly once");
});

await checkAsync("a turn with no tracing capability propagates the body's error", async () => {
  let thrown = null;
  try {
    await tracedTurn({
      agent: "FederationAgent",
      sessionId: "abc",
      operationId: "op1",
      run: async () => {
        throw new Error("model went away");
      },
    });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof Error, `expected the original error, got ${String(thrown)}`);
  assert.equal(thrown.message, "model went away");
});

await checkAsync("one turn opens one span carrying both ids and ends it once", async () => {
  const span = fakeSpan();
  const tracing = fakeTracing(span);
  const value = await tracedTurn({
    tracing,
    agent: "FederationAgent",
    sessionId: "abc",
    operationId: "op1",
    run: async () => 42,
  });
  assert.equal(value, 42);
  assert.equal(tracing.opened.length, 1, "a turn is one span, not one per model call");
  assert.equal(tracing.opened[0].name, TRACE_SPAN_NAME);
  assert.equal(span.ends, 1, "an unended span never reports");
  const attributes = Object.values(span.attributes);
  assert.ok(attributes.includes("abc"), "the span does not carry the session id");
  assert.ok(attributes.includes("op1"), "the span does not carry the operation id");
  assert.equal(span.attributes["blip.agent"], "FederationAgent");
  assert.deepEqual(span.statuses, [{ code: "ok" }], "a finished turn reports ok");
  assert.equal(span.exceptions.length, 0);
});

await checkAsync("a failing turn records the error on its span and still rethrows", async () => {
  const span = fakeSpan();
  const tracing = fakeTracing(span);
  let thrown = null;
  try {
    await tracedTurn({
      tracing,
      agent: "Researcher",
      sessionId: "abc",
      operationId: "op9",
      run: async () => {
        throw new Error("the sub-agent ended interrupted and has no report");
      },
    });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof Error, "the wrapper must not swallow the turn's error");
  assert.equal(span.ends, 1, "the span must end even when the turn threw");
  assert.equal(span.statuses.at(-1).code, "error");
  assert.equal(span.exceptions.length, 1, "the thrown error belongs on the span");
});

await checkAsync("an untraced span is left alone instead of accumulating attributes", async () => {
  const span = fakeSpan();
  span.isTraced = false;
  const tracing = fakeTracing(span);
  const value = await tracedTurn({
    tracing,
    agent: "FederationAgent",
    sessionId: "abc",
    operationId: "op1",
    run: async () => "ok",
  });
  assert.equal(value, "ok");
  assert.deepEqual(Object.keys(span.attributes), [], "a dropped span needs no attributes");
  assert.equal(span.ends, 1);
});

await checkAsync("tracedTurn never runs the body twice when the span ends", async () => {
  const span = fakeSpan();
  const tracing = fakeTracing(span);
  let ran = 0;
  await tracedTurn({
    tracing,
    agent: "FederationAgent",
    sessionId: "abc",
    operationId: "op1",
    run: async () => {
      ran += 1;
      return ran;
    },
  });
  assert.equal(ran, 1);
});

// ---------------------------------------------------- the tail-readable line ----
//
// A span nobody can read is decoration, and the platform's own trace viewer is not
// reachable from a terminal. One log line per settled span, only on the lane that
// asked, is what makes `wrangler tail` able to answer "did that operation trace".

await checkAsync("a settled span logs one line a tail can find by operation id", async () => {
  const span = fakeSpan();
  const tracing = fakeTracing(span);
  const cap = captureLogs();
  try {
    await tracedTurn({
      tracing,
      agent: "Researcher",
      sessionId: "abc",
      operationId: "op1",
      run: async () => "ok",
    });
  } finally {
    cap.restore();
  }
  assert.equal(cap.lines.length, 1, "one turn writes exactly one line");
  const line = cap.lines[0];
  assert.ok(line.includes("op1"), `the operation id is what a tail is searched by: ${line}`);
  assert.ok(line.includes("abc"), `the session id belongs on the same line: ${line}`);
  assert.ok(line.includes("Researcher"), `the line says which class ran it: ${line}`);
  assert.ok(line.includes("traced=true"), `the line says the platform kept the span: ${line}`);
  assert.ok(line.includes("status=ok"), `the line says how the turn settled: ${line}`);
});

await checkAsync("a span the platform dropped says so instead of implying a trace", async () => {
  const span = fakeSpan();
  span.isTraced = false;
  const tracing = fakeTracing(span);
  const cap = captureLogs();
  try {
    await tracedTurn({
      tracing,
      agent: "FederationAgent",
      sessionId: "abc",
      operationId: "op1",
      run: async () => "ok",
    });
  } finally {
    cap.restore();
  }
  assert.equal(cap.lines.length, 1);
  assert.ok(
    cap.lines[0].includes("traced=false"),
    `a dropped span must not read like a kept one: ${cap.lines[0]}`
  );
});

await checkAsync("a failing turn's line carries the error, not a fake ok", async () => {
  const span = fakeSpan();
  const tracing = fakeTracing(span);
  const cap = captureLogs();
  try {
    await assert.rejects(
      tracedTurn({
        tracing,
        agent: "FederationAgent",
        sessionId: "abc",
        operationId: "op1",
        run: async () => {
          throw new Error("model refused");
        },
      })
    );
  } finally {
    cap.restore();
  }
  assert.equal(cap.lines.length, 1);
  assert.ok(cap.lines[0].includes("status=error"), cap.lines[0]);
});

await checkAsync("a turn nobody asked to trace writes no log line at all", async () => {
  const cap = captureLogs();
  try {
    await tracedTurn({
      tracing: undefined,
      agent: "FederationAgent",
      sessionId: "abc",
      operationId: "op1",
      run: async () => "ok",
    });
  } finally {
    cap.restore();
  }
  assert.deepEqual(cap.lines, [], "ordinary traffic pays for no span and no line");
});

// ------------------------------------------------------ offline importability ----

check("src/observability.ts has no runtime imports, so plain Node can load it", () => {
  const source = readFileSync(new URL("../src/observability.ts", import.meta.url), "utf8");
  const valueImports = (source.match(/^\s*import\b[^\n]*$/gm) ?? []).filter(
    (line) => !/^\s*import\s+type\b/.test(line)
  );
  assert.deepEqual(
    valueImports,
    [],
    `a value import makes this module unimportable offline: ${valueImports.join(", ")}`
  );
  assert.equal(
    /\brequire\s*\(/.test(source),
    false,
    "a require() is a runtime dependency the offline resolver cannot supply"
  );
});

// ------------------------------------------------------------------ summary ----

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`observability: ${failures.length} failed`);
  process.exit(1);
}
