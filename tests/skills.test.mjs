// Native skills: SKILL.md parsing, the pure skill store, and the authenticated
// skill routes. Plain Node.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { parseSkill } from "../src/skill-parser.ts";
import {
  countSkills,
  deleteSkillRow,
  ensureSkillSchema,
  getSkillRow,
  listSkillRows,
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
    created_at: now,
    updated_at: now,
  });
  assert.equal(countSkills(sql), 1);
  assert.equal(getSkillRow(sql, "notes")?.body, "Use bullets.");
  assert.equal(listSkillRows(sql).length, 1);
  assert.equal(deleteSkillRow(sql, "notes"), true);
  assert.equal(getSkillRow(sql, "notes"), null);
});

const stored = new Map();
const registry = {
  async skillCatalog() {
    return [...stored.values()].map(({ name, description }) => ({ name, description }));
  },
  async skillGet(name) {
    return stored.get(name) ?? null;
  },
  async skillSave(name, description, body) {
    stored.set(name, { name, description, body });
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
  assert.deepEqual((await list.json()).skills, [{ name: "greet", description: "Say hello" }]);
  const read = await handleSkills(req("/api/skills/greet"), env);
  assert.match((await read.json()).skill.body, /Say hello/);
  const removed = await handleSkills(req("/api/skills/greet", "DELETE"), env);
  assert.equal(removed.status, 200);
  assert.equal(stored.size, 0);
});

if (failures.length) {
  for (const failure of failures) console.error("  FAIL " + failure);
  process.exit(1);
}
console.log("skills: passed");
