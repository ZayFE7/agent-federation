// Evidence tests: trusted callbacks only, injected hashing, missing/mismatch
// results, and an explicit truncation cap. No filesystem or SQL is touched.
// `node tests/goal-evidence.test.mjs`. Silent on success, exit 1 on failure.

import assert from "node:assert/strict";
import { collectEvidence } from "../src/goal-evidence.ts";

const failures = [];
async function check(name, fn) {
  try {
    await fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

function sources(overrides = {}) {
  return {
    runId: "run1",
    fileInfo: async () => null,
    artifact: async () => null,
    toolCalls: async () => [],
    ...overrides,
  };
}

await check("a file is hashed with the injected sha256 and checked by size and hash", async () => {
  const hashed = [];
  const ev = await collectEvidence(
    [{ type: "file", path: "out/report.md", min_bytes: 5, max_bytes: 100, sha256: "abc123" }],
    sources({
      fileInfo: async (path) => ({ exists: true, content: `hello:${path}` }),
      sha256: async (value) => {
        hashed.push(value);
        return "ABC123";
      },
    })
  );
  assert.equal(hashed.length, 1);
  assert.equal(ev.items.length, 1);
  const item = ev.items[0];
  assert.equal(item.kind, "file");
  assert.equal(item.status, "ok");
  assert.equal(item.bytes, Buffer.byteLength("hello:out/report.md"));
  assert.equal(item.sha256, "abc123");
  assert.equal(item.min_bytes, 5);
  assert.equal(item.expected_sha256, "abc123");
  assert.deepEqual(ev.missing, []);
  assert.deepEqual(ev.mismatches, []);
});

await check("manifest aliases size and hash are accepted and items carry ok", async () => {
  const ev = await collectEvidence(
    [{ type: "file", path: "out/a.md", sha256: "deadbeef" }],
    sources({
      fileInfo: async () => ({ exists: true, size: 12, hash: "DEADBEEF" }),
    })
  );
  assert.equal(ev.items[0].status, "ok");
  assert.equal(ev.items[0].ok, true);
  assert.equal(ev.items[0].bytes, 12);
  assert.equal(ev.items[0].sha256, "deadbeef");
});

await check("a missing file is reported as missing, not as pass", async () => {
  const ev = await collectEvidence(
    [{ type: "file", path: "out/missing.md" }],
    sources({ fileInfo: async () => ({ exists: false }) })
  );
  assert.equal(ev.items[0].status, "missing");
  assert.equal(ev.items[0].exists, false);
  assert.equal(ev.missing.length, 1);
  assert.match(ev.missing[0], /out\/missing\.md/);
});

await check("a size or hash mismatch is recorded in mismatches", async () => {
  const small = await collectEvidence(
    [{ type: "file", path: "out/small.md", min_bytes: 100 }],
    sources({ fileInfo: async () => ({ exists: true, bytes: 3 }) })
  );
  assert.equal(small.items[0].status, "mismatch");
  assert.match(small.mismatches[0], /smaller/);

  const hash = await collectEvidence(
    [{ type: "file", path: "out/hash.md", sha256: "a".repeat(64) }],
    sources({
      fileInfo: async () => ({ exists: true, bytes: 3, sha256: "b".repeat(64) }),
    })
  );
  assert.equal(hash.items[0].status, "mismatch");
  assert.match(hash.mismatches[0], /does not match/);
});

await check("one file lookup is shared by duplicate checks", async () => {
  let calls = 0;
  const ev = await collectEvidence(
    [
      { type: "file", path: "out/a.md" },
      { type: "file", path: "out/a.md", min_bytes: 1 },
    ],
    sources({
      fileInfo: async () => {
        calls += 1;
        return { exists: true, bytes: 4 };
      },
    })
  );
  assert.equal(calls, 1);
  assert.equal(ev.items.length, 2);
  assert.equal(ev.items.every((item) => item.status === "ok"), true);
});

await check("artifact presence is checked through the injected artifact store", async () => {
  const present = await collectEvidence(
    [{ type: "artifact", path: "out/report.md" }],
    sources({ artifact: async () => ({ path: "out/report.md", bytes: 42 }) })
  );
  assert.equal(present.items[0].status, "ok");
  assert.equal(present.items[0].present, true);
  const missing = await collectEvidence(
    [{ type: "artifact", path: "out/report.md" }],
    sources({ artifact: async () => null })
  );
  assert.equal(missing.items[0].status, "missing");
  assert.match(missing.missing[0], /artifact/);
});

await check("tool exit codes use toolExit or the ledger, and a missing call is missing", async () => {
  const fromExit = await collectEvidence(
    [{ type: "tool_exit", tool: "exec", code: 0 }],
    sources({ toolExit: async () => ({ exit_code: 0 }) })
  );
  assert.equal(fromExit.items[0].status, "ok");
  assert.equal(fromExit.items[0].code, 0);

  const fromLedger = await collectEvidence(
    [{ type: "tool_exit", tool: "exec", code: 2 }],
    sources({
      toolCalls: async () => [
        { tool: "exec", status: "finished", result: "exit 2 (failed)" },
      ],
    })
  );
  assert.equal(fromLedger.items[0].status, "ok");
  assert.equal(fromLedger.items[0].code, 2);
  assert.equal(fromLedger.items[0].calls, 1);

  const mismatch = await collectEvidence(
    [{ type: "tool_exit", tool: "exec", code: 0 }],
    sources({ toolExit: async () => 1 })
  );
  assert.equal(mismatch.items[0].status, "mismatch");
  assert.match(mismatch.mismatches[0], /does not match/);

  const absent = await collectEvidence(
    [{ type: "tool_exit", tool: "exec", code: 0 }],
    sources({ toolExit: async () => null })
  );
  assert.equal(absent.items[0].status, "missing");

  const noCode = await collectEvidence(
    [{ type: "tool_exit", tool: "exec", code: 0 }],
    sources({
      toolCalls: async () => [{ tool: "exec", status: "finished", result: "done" }],
    })
  );
  assert.equal(noCode.items[0].status, "error");
});

await check("tool_exit defaults to code 0 when the check omits it", async () => {
  const ev = await collectEvidence(
    [{ type: "tool_exit", tool: "exec" }],
    sources({ toolExit: async () => 0 })
  );
  assert.equal(ev.items[0].status, "ok");
  assert.equal(ev.items[0].expected_code, 0);
});

await check("text checks are delegated and no model prose enters evidence", async () => {
  const ev = await collectEvidence(
    [
      {
        type: "text",
        criterion: "The report names all three sources.",
      },
    ],
    sources()
  );
  assert.equal(ev.items[0].status, "delegated");
  assert.equal(ev.items[0].kind, "text");
  const serialized = JSON.stringify(ev);
  assert.match(serialized, /all three sources/);
  assert.equal(serialized.includes("The agent claimed it finished"), false);
});

await check("a forbidden effect is found in the tool ledger", async () => {
  const found = await collectEvidence(
    [{ type: "forbidden_effect", tool: "exec" }],
    sources({
      toolCalls: async () => [{ tool: "exec", side_effect: 1, status: "finished" }],
    })
  );
  assert.equal(found.items[0].status, "mismatch");
  assert.match(found.mismatches[0], /forbidden effect/);
  const absent = await collectEvidence(
    [{ type: "forbidden_effect", tool: "exec" }],
    sources({ toolCalls: async () => [{ tool: "lookup_online", side_effect: 0 }] })
  );
  assert.equal(absent.items[0].status, "ok");
});

await check("unknown checks and callback errors fail closed", async () => {
  const unknown = await collectEvidence([{ type: "magic" }], sources());
  assert.equal(unknown.items[0].status, "error");
  assert.match(unknown.errors[0], /unsupported check type/);

  const broken = await collectEvidence(
    [{ type: "file", path: "out/x" }],
    sources({
      fileInfo: async () => {
        throw new Error("sandbox down");
      },
    })
  );
  assert.equal(broken.items[0].status, "error");
  assert.match(broken.errors[0], /sandbox down/);
});

await check("oversized evidence is capped with an explicit truncation marker", async () => {
  const checks = Array.from({ length: 60 }, (_, i) => ({
    type: "file",
    path: `out/${i}.md`,
  }));
  const ev = await collectEvidence(
    checks,
    sources({
      fileInfo: async () => ({ exists: true, bytes: 1 }),
      max_bytes: 700,
    })
  );
  const actual = new TextEncoder().encode(JSON.stringify(ev)).length;
  assert.equal(ev.truncated, true);
  assert.ok(ev.omitted > 0);
  assert.equal(ev.bytes, actual);
  assert.ok(actual <= 700, `evidence ${actual} bytes exceeds cap`);
  assert.ok(JSON.stringify(ev).length > 0);
  assert.match(ev.note, /truncated/);
  assert.ok(ev.items.length < checks.length);
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`goal-evidence: ${failures.length} failed`);
  process.exit(1);
}
