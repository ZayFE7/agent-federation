// Contract for src/automation-schedule.ts: interval/daily due times, stable JSON,
// watcher fingerprints and excerpts, and source validation. Plain Node.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  defaultScheduleNext,
  nextDailyDue,
  nextIntervalDue,
  stableJson,
  validateScheduleSource,
  validateWatchSource,
  watcherExcerpt,
  watcherFingerprint,
} from "../src/automation-schedule.ts";

const encoder = new TextEncoder();
const failures = [];
let checks = 0;

async function check(name, fn) {
  checks += 1;
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: ${error && error.message ? error.message : String(error)}`);
  }
}

await check("nextIntervalDue schedules one interval ahead and is strictly future", () => {
  const from = Date.UTC(2026, 9, 26, 12, 0, 0);
  assert.equal(nextIntervalDue(5, from, from), from + 5 * 60_000);
  assert.equal(nextIntervalDue(15, from, from), from + 15 * 60_000);
  assert.equal(nextIntervalDue(5, from, from + 5 * 60_000), from + 10 * 60_000);
  assert.ok(nextIntervalDue(5, from, from + 7 * 60_000) > from + 7 * 60_000);
});

await check("nextIntervalDue enforces the 5-minute floor", () => {
  const from = Date.UTC(2026, 9, 26, 12, 0, 0);
  assert.equal(nextIntervalDue(1, from, from), from + 5 * 60_000);
  assert.equal(nextIntervalDue(0, from, from), from + 5 * 60_000);
  assert.equal(nextIntervalDue(-30, from, from), from + 5 * 60_000);
  assert.equal(nextIntervalDue(Number.NaN, from, from), from + 5 * 60_000);
});

await check("nextIntervalDue catches up from the original cadence", () => {
  const from = Date.UTC(2026, 9, 26, 12, 0, 0);
  assert.equal(nextIntervalDue(5, from, from + 12 * 60_000), from + 15 * 60_000);
  assert.equal(nextIntervalDue(15, from, from + 16 * 60_000), from + 30 * 60_000);
  assert.equal(nextIntervalDue(15, from, from + 60 * 60_000), from + 75 * 60_000);
});

await check("nextDailyDue returns the next UTC HH:MM in the same or next day", () => {
  const now = Date.UTC(2026, 9, 26, 14, 30);
  assert.equal(nextDailyDue("09:00", now, now), Date.UTC(2026, 9, 27, 9, 0));
  assert.equal(
    nextDailyDue("09:00", Date.UTC(2026, 9, 25, 8, 0), Date.UTC(2026, 9, 26, 8, 0)),
    Date.UTC(2026, 9, 26, 9, 0)
  );
  assert.equal(
    nextDailyDue("18:00", now, Date.UTC(2026, 9, 26, 14, 30)),
    Date.UTC(2026, 9, 26, 18, 0)
  );
});

await check("nextDailyDue is strictly future at the exact minute", () => {
  const now = Date.UTC(2026, 9, 26, 9, 0);
  assert.equal(nextDailyDue("09:00", now, now), Date.UTC(2026, 9, 27, 9, 0));
  assert.equal(
    nextDailyDue("09:00", now, Date.UTC(2026, 9, 26, 9, 0, 1)),
    Date.UTC(2026, 9, 27, 9, 0)
  );
});

await check("nextDailyDue rolls over month and year boundaries", () => {
  assert.equal(
    nextDailyDue("00:30", Date.UTC(2026, 11, 31, 23, 0), Date.UTC(2026, 11, 31, 23, 0)),
    Date.UTC(2027, 0, 1, 0, 30)
  );
  assert.equal(
    nextDailyDue("09:00", Date.UTC(2028, 1, 28, 10, 0), Date.UTC(2028, 1, 28, 10, 0)),
    Date.UTC(2028, 1, 29, 9, 0)
  );
});

await check("nextDailyDue validates HH:MM", () => {
  const now = Date.UTC(2026, 9, 26, 12, 0);
  for (const bad of ["24:00", "9:05", "09:60", "0900", "", "09:5", "09:005", " 09:05"]) {
    assert.throws(() => nextDailyDue(bad, now, now), bad);
  }
});

await check("stableJson sorts object keys but keeps arrays in order", () => {
  assert.equal(stableJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(stableJson({ b: 1, a: 2 }), stableJson({ a: 2, b: 1 }));
  assert.equal(
    stableJson({ z: [3, { b: 1, a: 2 }], a: { d: 4, c: 3 } }),
    '{"a":{"c":3,"d":4},"z":[3,{"a":2,"b":1}]}'
  );
  assert.equal(stableJson([3, 1, 2]), "[3,1,2]");
  assert.equal(stableJson([1, { b: 2, a: 1 }]), '[1,{"a":1,"b":2}]');
  assert.equal(stableJson({ 2: "a", 10: "b" }), '{"10":"b","2":"a"}');
});

await check("stableJson handles primitives and omitted undefined values", () => {
  assert.equal(stableJson(null), "null");
  assert.equal(stableJson(undefined), "null");
  assert.equal(stableJson("x"), '"x"');
  assert.equal(stableJson(5), "5");
  assert.equal(stableJson(true), "true");
  assert.equal(stableJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(stableJson([1, undefined, 2]), "[1,null,2]");
});

await check("watcherFingerprint ignores JSON key order", async () => {
  const left = await watcherFingerprint(
    encoder.encode('{"b":2,"a":1}'),
    "application/json; charset=utf-8"
  );
  const right = await watcherFingerprint(encoder.encode('{"a":1,"b":2}'), "application/json");
  assert.equal(left, right);
  assert.match(left, /^[a-f0-9]{64}$/);
  assert.equal(left, createHash("sha256").update(stableJson({ a: 1, b: 2 })).digest("hex"));
});

await check("watcherFingerprint hashes raw bytes for non-JSON and changed content differs", async () => {
  const rawLeft = await watcherFingerprint(encoder.encode('{"b":2,"a":1}'), "text/plain");
  const rawRight = await watcherFingerprint(encoder.encode('{"a":1,"b":2}'), null);
  assert.notEqual(rawLeft, rawRight);
  assert.equal(rawLeft, createHash("sha256").update('{"b":2,"a":1}').digest("hex"));
  assert.equal(
    await watcherFingerprint(encoder.encode('{"a":2,"b":1}'), "application/json"),
    createHash("sha256").update(stableJson({ a: 2, b: 1 })).digest("hex")
  );
});

await check("watcherFingerprint falls back to raw bytes for invalid JSON", async () => {
  const body = encoder.encode("{not json");
  assert.equal(
    await watcherFingerprint(body, "application/json"),
    createHash("sha256").update(body).digest("hex")
  );
});

await check("watcherExcerpt compacts JSON and falls back to text", () => {
  assert.equal(watcherExcerpt(encoder.encode("hello"), "text/plain"), "hello");
  assert.equal(
    watcherExcerpt(encoder.encode('{ "b": 2, "a": 1 }'), "application/json"),
    '{"a":1,"b":2}'
  );
  assert.equal(watcherExcerpt(encoder.encode("{not json"), "application/json"), "{not json");
});

await check("watcherExcerpt caps output at 4 KB without splitting UTF-8", () => {
  const capped = watcherExcerpt(encoder.encode("x".repeat(10 * 1024)), "text/plain");
  assert.equal(capped.length, 4096);
  assert.ok(Buffer.byteLength(capped, "utf8") <= 4096);

  const multibyte = watcherExcerpt(encoder.encode("é".repeat(3000)), "text/plain");
  assert.ok(Buffer.byteLength(multibyte, "utf8") <= 4096);
  assert.equal(multibyte.endsWith("\uFFFD"), false);
});

await check("validateWatchSource accepts a public URL, interval, and small headers", () => {
  assert.equal(
    validateWatchSource({
      type: "watch",
      url: "https://example.com/data.json",
      interval_minutes: 5,
    }),
    null
  );
  assert.equal(
    validateWatchSource({
      type: "watch",
      url: "https://example.com/data.json",
      interval_minutes: 15,
      fire_on_first: true,
      headers: { Accept: "application/json" },
    }),
    null
  );
});

await check("validateWatchSource rejects bad URLs, intervals, headers, and flags", () => {
  const base = { type: "watch", url: "https://example.com/data", interval_minutes: 5 };
  assert.notEqual(validateWatchSource({ ...base, url: "http://localhost/x" }), null);
  assert.notEqual(validateWatchSource({ ...base, url: "file:///etc/passwd" }), null);
  assert.notEqual(validateWatchSource({ ...base, url: "javascript:alert(1)" }), null);
  assert.notEqual(validateWatchSource({ ...base, interval_minutes: 4 }), null);
  assert.notEqual(validateWatchSource({ ...base, interval_minutes: 0 }), null);
  assert.notEqual(validateWatchSource({ ...base, interval_minutes: Number.NaN }), null);
  assert.notEqual(validateWatchSource({ ...base, fire_on_first: "yes" }), null);
  assert.notEqual(validateWatchSource({ ...base, headers: { "X-N": 1 } }), null);
  assert.notEqual(validateWatchSource({ ...base, headers: { "X-Huge": "a".repeat(9000) } }), null);
  assert.notEqual(validateWatchSource({ ...base, headers: { "X-Bad": "a\r\nb" } }), null);
});

await check("validateScheduleSource requires exactly one valid schedule", () => {
  assert.equal(validateScheduleSource({ type: "schedule", every_minutes: 5 }), null);
  assert.equal(validateScheduleSource({ type: "schedule", every_minutes: 15 }), null);
  assert.equal(validateScheduleSource({ type: "schedule", daily_at: "00:00" }), null);
  assert.equal(validateScheduleSource({ type: "schedule", daily_at: "23:59" }), null);
  assert.notEqual(validateScheduleSource({ type: "schedule", every_minutes: 4 }), null);
  assert.notEqual(validateScheduleSource({ type: "schedule", every_minutes: "5" }), null);
  assert.notEqual(validateScheduleSource({ type: "schedule" }), null);
  assert.notEqual(
    validateScheduleSource({ type: "schedule", every_minutes: 5, daily_at: "09:00" }),
    null
  );
  assert.notEqual(validateScheduleSource({ type: "schedule", daily_at: "9:00" }), null);
  assert.notEqual(validateScheduleSource({ type: "schedule", daily_at: "24:00" }), null);
  assert.notEqual(validateScheduleSource({ type: "schedule", daily_at: "09:60" }), null);
});

await check("defaultScheduleNext returns the first due time or null", () => {
  const now = Date.UTC(2026, 9, 26, 14, 30);
  assert.equal(
    defaultScheduleNext({ type: "schedule", every_minutes: 5 }, now),
    now + 5 * 60_000
  );
  assert.equal(defaultScheduleNext({ type: "schedule", every_minutes: 1 }, now), null);
  assert.equal(
    defaultScheduleNext({ type: "schedule", daily_at: "09:00" }, now),
    Date.UTC(2026, 9, 27, 9, 0)
  );
  assert.equal(defaultScheduleNext({ type: "schedule", every_minutes: 4 }, now), null);
  assert.equal(defaultScheduleNext({ type: "schedule", daily_at: "bad" }, now), null);
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`automation-schedule: ${failures.length} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`automation-schedule: ${checks} checks, 0 failed`);
