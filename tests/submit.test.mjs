// Task 23: POST /api/sessions/:id/message is submit-and-return.
//
// The worker's job shrank to three things the DO cannot do for itself: gate the
// id (shape and existence), relay the receipt unchanged, and schedule the
// registry touch. Everything the person waits on (the model, the tools, the
// durable stream) runs in the DO. This file pins the two halves of that split
// that are visible from the worker:
//
//   1. the response carries BOTH ids and nothing else, so the UI has what it
//      needs to open an EventSource before the model has said a word;
//   2. `submitTurn` is the only turn RPC the route calls, because a route that
//      waited would turn the durable stream into a slower version of the old route.
//
// And the hostile-id half: a segment that only turns hostile when decoded is a
// 400 BEFORE any namespace or registry call, so a bad name never instantiates a
// DO (R76 gate 2). Plain Node, no framework: `node tests/submit.test.mjs`.

import assert from "node:assert/strict";
import { handleFetch } from "../src/routes.ts";

const failures = [];

function checkAsync(name, fn) {
  return fn().catch((err) => {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  });
}

/**
 * A registry that only records, and a federation namespace whose stub is the
 * submit contract itself. `exists` answers true so the case is always about
 * the send, never gate 3; the hostile-id cases never get this far.
 */
function world() {
  const registryCalls = [];
  // The touch settles only when the test releases it, so "the route did not
  // await the touch" is an observation, not a timing assumption.
  let releaseTouch;
  const touchGate = new Promise((resolve) => {
    releaseTouch = resolve;
  });
  const registry = {
    async exists(id) {
      registryCalls.push(["exists", id]);
      return true;
    },
    async touch(id) {
      registryCalls.push(["touch-start", id]);
      await touchGate;
      registryCalls.push(["touch-done", id]);
    },
  };
  const names = [];
  const addressed = [];
  const submits = [];
  const stubs = new Map();
  const agent = {
    idFromName(name) {
      names.push(name);
      return { __sessionName: name, toString: () => `do:${name}` };
    },
    get(id) {
      const name = id.__sessionName;
      addressed.push(name);
      if (!stubs.has(name)) {
        stubs.set(name, {
          async submitTurn(...args) {
            submits.push({ name, args, arity: args.length });
            return { operationId: "op-7", streamId: `s:${name}:op-7` };
          },
        });
      }
      return stubs.get(name);
    },
  };
  const env = {
    AGENT_API_KEY: "k",
    FEDERATION_AGENT: agent,
    REGISTRY: {
      idFromName: () => ({ toString: () => "registry" }),
      get: () => registry,
    },
  };
  const promised = [];
  const ctx = {
    waitUntil(promise) {
      promised.push(promise);
    },
    passThroughOnException() {},
  };
  return { env, ctx, registryCalls, names, addressed, submits, promised, releaseTouch };
}

const post = (path, body) =>
  new Request(`https://blip.test${path}`, {
    method: "POST",
    headers: { authorization: "Bearer k" },
    body,
  });

await checkAsync("the accepted send returns the receipt and never waits on the turn", async () => {
  const w = world();
  const res = await handleFetch(
    post("/api/sessions/abc/message", JSON.stringify({ content: "hello" })),
    w.env,
    w.ctx
  );
  assert.equal(res.status, 200);
  assert.deepEqual(
    await res.json(),
    { ok: true, streamId: "s:abc:op-7", operationId: "op-7" },
    "both ids come straight from the DO, and no reply text is invented here"
  );
  assert.equal(w.submits.length, 1, "the send reaches the DO exactly once");
  assert.equal(w.submits[0].arity, 3, "submitTurn(content, tier, sessionId)");
  assert.deepEqual(w.submits[0].args, ["hello", undefined, "abc"]);
  assert.deepEqual(w.names, ["abc"]);
  assert.deepEqual(w.addressed, ["abc"]);
  assert.deepEqual(
    w.registryCalls,
    [["exists", "abc"], ["touch-start", "abc"]],
    "the touch is scheduled, and the response did not wait for it to settle"
  );
  assert.equal(w.promised.length, 1, "the accepted send hands one promise to waitUntil");
  w.releaseTouch();
  await w.promised[0];
  assert.deepEqual(w.registryCalls, [
    ["exists", "abc"],
    ["touch-start", "abc"],
    ["touch-done", "abc"],
  ]);
});

await checkAsync("tier is forwarded when it is known and dropped when it is not", async () => {
  for (const [sent, expected] of [
    ["cheap", "cheap"],
    ["primary", "primary"],
    ["smart", undefined],
    [7, undefined],
  ]) {
    const w = world();
    const res = await handleFetch(
      post("/api/sessions/abc/message", JSON.stringify({ content: "hello", tier: sent })),
      w.env,
      w.ctx
    );
    assert.equal(res.status, 200, `tier ${JSON.stringify(sent)} is not a body error`);
    assert.equal(w.submits[0].args[1], expected, `tier ${JSON.stringify(sent)}`);
  }
});

// Shapes that survive WHATWG path normalization and only turn hostile when the
// segment is decoded: this gate is the reason none of them can name a DO.
await checkAsync("a hostile session id is a 400 before any namespace or registry call", async () => {
  for (const raw of [
    encodeURIComponent("abc/def"),
    encodeURIComponent("a b"),
    encodeURIComponent("abc..def"),
    encodeURIComponent("../../etc"),
    "x".repeat(41),
    "%252e%252e",
  ]) {
    const w = world();
    const res = await handleFetch(
      post(`/api/sessions/${raw}/message`, JSON.stringify({ content: "hello" })),
      w.env,
      w.ctx
    );
    assert.equal(res.status, 400, `${raw} must be refused by the shape rule`);
    assert.deepEqual(await res.json(), { ok: false, error: "invalid session id" });
    assert.deepEqual(w.names, [], `${raw} must not reach idFromName`);
    assert.deepEqual(w.addressed, [], `${raw} must not address a DO`);
    assert.deepEqual(w.registryCalls, [], `${raw} must not reach the registry`);
    assert.equal(w.submits.length, 0, `${raw} must not submit`);
  }
});

if (failures.length > 0) {
  for (const failure of failures) console.log(`FAIL ${failure}`);
  process.exit(1);
}
process.exit(0);
