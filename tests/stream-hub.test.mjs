// Unit tests for src/stream-hub.ts: one durable stream per operation, with a
// writer acquired lazily and frames buffered in order until it exists.
// Plain Node: `node tests/stream-hub.test.mjs`. Silent on success (exit 0).

import assert from "node:assert/strict";
import { StreamHub, streamIdFor } from "../src/stream-hub.ts";

const failures = [];

async function check(name, fn) {
  try {
    await fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

function fakePort() {
  const opened = [];
  const appends = [];
  const closes = [];
  const errors = [];
  const writers = new Map();
  const port = {
    async open(id, options) {
      opened.push({ id, options });
      if (writers.has(id)) return writers.get(id);
      const writer = {
        append(chunk) {
          appends.push({ id, chunk });
          return appends.length;
        },
        close(options) {
          closes.push({ id, options });
        },
        error(reason, options) {
          errors.push({ id, reason, options });
        },
      };
      writers.set(id, writer);
      return writer;
    },
    async status(id) {
      return writers.has(id) ? { state: "live" } : null;
    },
  };
  return { port, opened, appends, closes, errors };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const sql = { exec: () => ({ results: [] }) };

function stateSql() {
  const terminal = new Set();
  return {
    exec(query, ...bindings) {
      const text = query.trimStart();
      if (text.startsWith("CREATE TABLE")) return { results: [] };
      if (text.startsWith("SELECT terminal")) {
        return { results: terminal.has(bindings[0]) ? [{ terminal: 1 }] : [] };
      }
      if (text.startsWith("INSERT INTO stream_state")) {
        terminal.add(bindings[0]);
        return { results: [] };
      }
      return { results: [] };
    },
  };
}

await check("streamIdFor is the one namespace this build owns", () => {
  assert.equal(streamIdFor("abc", "op1"), "s:abc:op1");
});

await check("write on an unopened id returns false and writes nothing", () => {
  const fake = fakePort();
  const hub = new StreamHub(fake.port, sql);
  assert.equal(hub.write("s:abc:op1", { t: "text", d: "hi" }), false);
  assert.deepEqual(fake.appends, []);
});

await check("open is idempotent and write appends the frame verbatim", async () => {
  const fake = fakePort();
  const hub = new StreamHub(fake.port, sql);
  await hub.open("s:abc:op1", "abc");
  await hub.open("s:abc:op1", "abc");
  assert.equal(fake.opened.length, 1, "a second open must not create a second stream");
  assert.deepEqual(fake.opened[0].options, { tag: "abc" });
  assert.equal(hub.write("s:abc:op1", { t: "text", d: "hi" }), true);
  assert.deepEqual(fake.appends[0].chunk, { t: "text", d: "hi" });
});

await check("feed before the writer exists buffers frames and flushes them in order", async () => {
  const fake = fakePort();
  const hub = new StreamHub(fake.port, sql);
  hub.feed("s:abc:op1", "abc", [{ t: "text", d: "a" }]);
  hub.feed("s:abc:op1", "abc", [{ t: "text", d: "b" }, { t: "text", d: "c" }]);
  assert.deepEqual(fake.appends, []);
  await tick();
  assert.deepEqual(
    fake.appends.map((entry) => entry.chunk.d),
    ["a", "b", "c"]
  );
});

await check("close then write returns false and never reopens", async () => {
  const fake = fakePort();
  const hub = new StreamHub(fake.port, sql);
  await hub.open("s:abc:op1", "abc");
  assert.equal(hub.close("s:abc:op1"), true);
  assert.equal(hub.write("s:abc:op1", { t: "text", d: "late" }), false);
  assert.equal(fake.closes.length, 1);
});

await check("fail after close is a no-op", async () => {
  const fake = fakePort();
  const hub = new StreamHub(fake.port, sql);
  await hub.open("s:abc:op1", "abc");
  hub.close("s:abc:op1");
  assert.equal(hub.fail("s:abc:op1", "boom"), false);
  assert.deepEqual(fake.errors, []);
});

await check("fail writes one error frame and settles the stream errored", async () => {
  const fake = fakePort();
  const hub = new StreamHub(fake.port, sql);
  await hub.open("s:abc:op1", "abc");
  assert.equal(hub.fail("s:abc:op1", "boom"), true);
  assert.deepEqual(fake.appends.at(-1).chunk, { t: "error", message: "boom" });
  assert.equal(fake.errors.length, 1);
  assert.equal(fake.errors[0].reason, "boom");
});

await check("finish writes the done frame and then closes, once", async () => {
  const fake = fakePort();
  const hub = new StreamHub(fake.port, sql);
  await hub.open("s:abc:op1", "abc");
  hub.finish("s:abc:op1", "abc", "the reply");
  hub.finish("s:abc:op1", "abc", "again");
  assert.deepEqual(fake.appends.at(-1).chunk, { t: "done", reply: "the reply" });
  assert.equal(fake.appends.filter((entry) => entry.chunk.t === "done").length, 1);
  assert.equal(fake.closes.length, 1);
});

await check("close settles the id and a second close is a no-op", async () => {
  const fake = fakePort();
  const hub = new StreamHub(fake.port, sql);
  await hub.open("s:abc:op1", "abc");
  assert.equal(hub.close("s:abc:op1"), true);
  assert.equal(hub.settled("s:abc:op1"), true);
  assert.equal(hub.close("s:abc:op1"), false);
  assert.equal(fake.closes.length, 1);
});

await check("fail settles the id and close cannot run afterwards", async () => {
  const fake = fakePort();
  const hub = new StreamHub(fake.port, sql);
  await hub.open("s:abc:op1", "abc");
  assert.equal(hub.fail("s:abc:op1", "boom"), true);
  assert.equal(hub.settled("s:abc:op1"), true);
  assert.equal(hub.close("s:abc:op1"), false);
  assert.equal(fake.closes.length, 0);
});

await check("a fresh hub over the same storage refuses a second terminal frame", async () => {
  const state = stateSql();
  const first = fakePort();
  const hub = new StreamHub(first.port, state);
  await hub.open("s:abc:op1", "abc");
  hub.finish("s:abc:op1", "abc", "the reply");
  assert.equal(first.appends.filter((entry) => entry.chunk.t === "done").length, 1);

  // Simulated eviction: same DO storage, no in-memory writer, no terminal set.
  const second = fakePort();
  const restarted = new StreamHub(second.port, state);
  assert.equal(restarted.settled("s:abc:op1"), true);
  assert.equal(restarted.write("s:abc:op1", { t: "done", reply: "again" }), false);
  restarted.finish("s:abc:op1", "abc", "again");
  restarted.fail("s:abc:op1", "again");
  await tick();
  assert.equal(second.opened.length, 0, "a settled stream must not reopen after eviction");
  assert.deepEqual(second.appends, []);
  assert.deepEqual(second.closes, []);
  assert.deepEqual(second.errors, []);
});

await check("the hub exposes the port it was given", () => {
  const fake = fakePort();
  const hub = new StreamHub(fake.port, sql);
  assert.equal(hub.streams, fake.port);
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`stream-hub: ${failures.length} failed`);
  process.exit(1);
}
