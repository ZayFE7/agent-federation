// Native skills: SKILL.md parsing, the pure skill store, and the authenticated
// skill routes. Plain Node.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { unzipSync, zipSync } from "fflate";
import { Buffer } from "node:buffer";
import { parseSkill } from "../src/skill-parser.ts";
import { packagesFromZip } from "../src/skill-import.ts";
import {
  countSkills,
  deleteSkillRow,
  ensureSkillSchema,
  getSkillRow,
  listSkillFileRows,
  listSkillRows,
  upsertSkillFiles,
  upsertSkillRow,
} from "../src/skill-store.ts";
import { handleSkills } from "../src/skill-routes.ts";

const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log("  PASS " + name);
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
    console.log("  FAIL " + name);
  }
}

await check("a Claude Code SKILL.md parses name, description and body", () => {
  const parsed = parseSkill(`---
name: commit-helper
description: Writes a clean commit message.
---

# Commit helper

Read the diff and write a commit message.`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.skill.name, "commit-helper");
  assert.equal(parsed.skill.description, "Writes a clean commit message.");
  assert.match(parsed.skill.body, /Read the diff/);
});

await check("folded descriptions and a heading name are accepted", () => {
  const parsed = parseSkill(`---
name: notes
description: >-
  Turn a rough thought into
  a short set of notes.
---

Use bullets.`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.skill.description, "Turn a rough thought into a short set of notes.");
});

await check("missing frontmatter uses the heading as the name", () => {
  const parsed = parseSkill("# Release checklist\n\nCheck the changelog.");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.skill.name, "release-checklist");
  assert.equal(parsed.skill.description, "Check the changelog.");
});

await check("empty, nameless or invalid skills are refused", () => {
  assert.equal(parseSkill("").ok, false);
  assert.equal(parseSkill("---\nname: !!!\ndescription: x\n---\nbody").ok, false);
  assert.equal(parseSkill("---\nname: x\n---\n\n").ok, false);
});

const db = new DatabaseSync(":memory:");
const sql = {
  exec(query, ...bindings) {
    const parts = query.split("?");
    if (parts.length !== bindings.length + 1) throw new Error("placeholder mismatch");
    return { results: db.prepare(parts.join("?")).all(...bindings) };
  },
};

await check("skill store upserts, lists, counts and deletes", () => {
  ensureSkillSchema(sql);
  const now = Date.now();
  upsertSkillRow(sql, {
    id: "notes",
    name: "notes",
    description: "Make notes",
    body: "Use bullets.",
    source: "test",
    file_count: 1,
    bytes: 8,
    created_at: now,
    updated_at: now,
  });
  upsertSkillFiles(sql, "notes", [
    { path: "SKILL.md", bytes: 8, contentBase64: "VXNlIGJ1bGxldHM=" },
  ]);
  assert.equal(countSkills(sql), 1);
  assert.equal(getSkillRow(sql, "notes")?.body, "Use bullets.");
  assert.equal(listSkillRows(sql).length, 1);
  assert.deepEqual(listSkillFileRows(sql, "notes").map((f) => f.path), ["SKILL.md"]);
  assert.equal(deleteSkillRow(sql, "notes"), true);
  assert.equal(getSkillRow(sql, "notes"), null);
  assert.deepEqual(listSkillFileRows(sql, "notes"), []);
});

await check("a file over one SQLite row is stored in chunks and reads back whole", () => {
  const now = Date.now();
  const content = "QUJD".repeat(250_000);
  upsertSkillRow(sql, {
    id: "chunked",
    name: "chunked",
    description: "Large file",
    body: "Use lib/big.js.",
    source: "test",
    file_count: 2,
    bytes: 750_010,
    created_at: now,
    updated_at: now,
  });
  upsertSkillFiles(sql, "chunked", [
    { path: "SKILL.md", bytes: 3, contentBase64: "QUJD" },
    { path: "lib/big.js", bytes: 750_000, contentBase64: content },
  ]);
  const files = listSkillFileRows(sql, "chunked");
  assert.equal(files.length, 2);
  assert.equal(files.find((f) => f.path === "lib/big.js").content_b64, content);
  const chunks = sql.exec(
    "SELECT idx FROM skill_file_chunks WHERE skill_id = ? ORDER BY idx",
    "chunked"
  ).results;
  assert.equal(chunks.length, 2, "a 1 MB base64 file must not occupy one row");
  assert.equal(deleteSkillRow(sql, "chunked"), true);
  assert.equal(
    sql.exec("SELECT COUNT(*) AS count FROM skill_file_chunks").results[0].count,
    0
  );
});

await check("a GitHub tree subfolder filters past the codeload archive prefix", () => {
  const zipped = zipSync({
    "repo-main/README.md": new TextEncoder().encode("# Repo"),
    "repo-main/skills/demo/SKILL.md": new TextEncoder().encode(
      "---\nname: demo\ndescription: Demo in a tree\n---\nDo it."
    ),
    "repo-main/skills/demo/scripts/run.py": new TextEncoder().encode("print('x')"),
    "repo-main/skills/other/SKILL.md": new TextEncoder().encode(
      "---\nname: other\ndescription: Other\n---\nOther."
    ),
  });
  const parsed = packagesFromZip(
    zipped,
    "https://github.com/owner/repo/tree/main/skills/demo",
    "skills/demo"
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.packages.length, 1);
  assert.equal(parsed.packages[0].name, "demo");
  assert.deepEqual(
    parsed.packages[0].files.map((f) => f.path).sort(),
    ["SKILL.md", "scripts/run.py"]
  );
});

await check("real long descriptions and 100k bodies are accepted", () => {
  const parsed = parseSkill(
    `---\nname: big-skill\ndescription: ${"d".repeat(900)}\n---\n${"Use the tool carefully.\n".repeat(6000)}`
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.skill.description.length, 900);
  assert.ok(parsed.skill.body.length > 100_000);
});

await check("a zip package keeps every file under its SKILL.md root", () => {
  const zipped = zipSync({
    "demo/SKILL.md": new TextEncoder().encode(
      "---\nname: demo\ndescription: Demo package\n---\nDo the demo."
    ),
    "demo/scripts": new Uint8Array(0),
    "demo/scripts/run.py": new TextEncoder().encode("print('hi')"),
    "demo/lib/util.js": new TextEncoder().encode("export const x = 1;"),
    "__MACOSX/._SKILL.md": new Uint8Array([1, 2, 3]),
  });
  const parsed = packagesFromZip(zipped, "https://example.test/demo.zip");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.packages[0].name, "demo");
  assert.equal(parsed.packages[0].files.length, 3);
  assert.deepEqual(
    parsed.packages[0].files.map((f) => f.path).sort(),
    ["SKILL.md", "lib/util.js", "scripts/run.py"]
  );
  assert.deepEqual(parsed.skipped, []);
});

await check("a bad skill folder is reported while valid siblings still import", () => {
  const zipped = zipSync({
    "bundle/good/SKILL.md": new TextEncoder().encode(
      "---\nname: good\ndescription: Works\n---\nDo it."
    ),
    "bundle/bad/SKILL.md": new TextEncoder().encode("---\nname: bad\ndescription: x\n---\n\n"),
  });
  const parsed = packagesFromZip(zipped, "upload");
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.packages.map((p) => p.name), ["good"]);
  assert.equal(parsed.skipped.length, 1);
  assert.match(parsed.skipped[0].path, /bad/);
  assert.match(parsed.skipped[0].reason, /no instructions/);
});

const stored = new Map();
const registry = {
  async skillCatalog() {
    return [...stored.values()].map(({ name, description, files, source }) => ({
      name,
      description,
      fileCount: files.length,
      source,
    }));
  },
  async skillGet(name) {
    const skill = stored.get(name);
    return skill
      ? {
          name: skill.name,
          description: skill.description,
          body: skill.body,
          source: skill.source,
          files: [...skill.files]
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
            .map((f) => ({ path: f.path, bytes: f.bytes })),
        }
      : null;
  },
  async skillFiles(name) {
    const skill = stored.get(name);
    return skill
      ? [...skill.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      : null;
  },
  async skillSave(name, description, body, files, source) {
    stored.set(name, { name, description, body, files, source });
    return true;
  },
  async skillDelete(name) {
    return stored.delete(name);
  },
};
const env = {
  AGENT_API_KEY: "test-agent-key",
  REGISTRY: {
    idFromName: (name) => ({ name }),
    get: () => registry,
  },
};
const req = (path, method = "GET", body) =>
  new Request("https://blip.test" + path, {
    method,
    headers: {
      authorization: "Bearer test-agent-key",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

await check("skill routes require auth", async () => {
  const res = await handleSkills(new Request("https://blip.test/api/skills"), env);
  assert.equal(res.status, 401);
});

await check("skill routes save, list, read and delete", async () => {
  const created = await handleSkills(
    req("/api/skills", "POST", {
      text: "---\nname: greet\ndescription: Say hello\n---\nSay hello in one line.",
    }),
    env
  );
  assert.equal(created.status, 200);
  const list = await handleSkills(req("/api/skills"), env);
  assert.deepEqual((await list.json()).skills, [
    { name: "greet", description: "Say hello", fileCount: 0, source: "manual" },
  ]);
  const read = await handleSkills(req("/api/skills/greet"), env);
  assert.match((await read.json()).skill.body, /Say hello/);
  const removed = await handleSkills(req("/api/skills/greet", "DELETE"), env);
  assert.equal(removed.status, 200);
  assert.equal(stored.size, 0);
});

await check("a zip upload installs a multi-file package and archives back byte-identical", async () => {
  const zipped = zipSync({
    "toolkit/SKILL.md": new TextEncoder().encode(
      "---\nname: toolkit\ndescription: Multi-file toolkit\n---\nRun scripts/run.py."
    ),
    "toolkit/scripts/run.py": new TextEncoder().encode("print('hi')\n"),
    "toolkit/lib/deep/util.js": new TextEncoder().encode("export const x = 1;\n"),
  });
  const imported = await handleSkills(
    req("/api/skills/import", "POST", {
      archiveBase64: Buffer.from(zipped).toString("base64"),
    }),
    env
  );
  assert.equal(imported.status, 200);
  const result = await imported.json();
  assert.equal(result.packages, 1);
  assert.equal(result.skills[0].files, 3);
  assert.equal(result.skills[0].source, "upload");

  const fake = stored.get("toolkit");
  assert.equal(fake.files.length, 3);
  assert.equal(fake.files.find((f) => f.path === "scripts/run.py").bytes, 12);

  const read = await handleSkills(req("/api/skills/toolkit"), env);
  const definition = (await read.json()).skill;
  assert.deepEqual(
    definition.files.map((f) => f.path),
    ["SKILL.md", "lib/deep/util.js", "scripts/run.py"]
  );

  const archive = await handleSkills(req("/api/skills/toolkit/archive"), env);
  assert.equal(archive.status, 200);
  assert.equal(archive.headers.get("content-type"), "application/zip");
  const back = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  assert.deepEqual(Object.keys(back).sort(), [
    "SKILL.md",
    "lib/deep/util.js",
    "scripts/run.py",
  ]);
  assert.equal(new TextDecoder().decode(back["scripts/run.py"]), "print('hi')\n");
});

await check("a zip with no SKILL.md is rejected without touching the library", async () => {
  const zipped = zipSync({ "readme.txt": new TextEncoder().encode("nothing here") });
  const res = await handleSkills(
    req("/api/skills/import", "POST", {
      archiveBase64: Buffer.from(zipped).toString("base64"),
    }),
    env
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /no SKILL\.md/);
  assert.equal(stored.has("readme"), false);
});

if (failures.length) {
  for (const failure of failures) console.error("  FAIL " + failure);
  process.exit(1);
}
console.log("skills: passed");
