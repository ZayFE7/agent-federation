// End-to-end test of the memory + task storage layer against a real SQLite
// (node:sqlite). Compiles src/memory.ts to JS with esbuild, then drives the
// actual exported functions. Proves: text recall (#26) and the one-off prune
// (#25). Run: node tests/memory.test.mjs
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// esbuild lives in the deploy tree (repo-clone has no node_modules of its own).
// Take the first candidate that actually holds esbuild/lib/main.js, so this file
// runs from either tree with no env var set: BLIP_DEPLOY_NM when present, this
// tree's own node_modules, then the sibling ../project/agent-federation layout.
const NM_CANDIDATES = [
  process.env.BLIP_DEPLOY_NM,
  join(root, "node_modules"),
  join(here, "..", "..", "project", "agent-federation", "node_modules"),
].filter(Boolean);

const hasEsbuild = (nm) => existsSync(join(nm, "esbuild", "lib", "main.js"));
const DEPLOY_NM = NM_CANDIDATES.find(hasEsbuild);

if (!DEPLOY_NM) {
  console.log("  FAIL esbuild/lib/main.js not found, cannot compile src/memory.ts");
  console.log("  searched:");
  for (const nm of NM_CANDIDATES) console.log("    " + nm);
  console.log("  set BLIP_DEPLOY_NM to a node_modules directory that contains esbuild");
  process.exit(1);
}

const { build } = await import(
  pathToFileURL(join(DEPLOY_NM, "esbuild", "lib", "main.js")).href
);
const out = join(tmpdir(), "blip-memory-test.mjs");

await build({
  entryPoints: [join(root, "src", "memory.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  logLevel: "silent",
});

const M = await import(pathToFileURL(out).href);

// Adapt node:sqlite to the SqlHandle contract used by the app (exec -> {results}).
const db = new DatabaseSync(":memory:");
const sql = {
  exec(query, ...bindings) {
    const parts = query.split("?");
    if (parts.length !== bindings.length + 1)
      throw new Error(`placeholder mismatch: ${parts.length - 1} vs ${bindings.length}`);
    const stmt = db.prepare(parts.join("?"));
    const res = stmt.all(...bindings);
    return { results: res };
  },
};

let pass = 0,
  fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass++;
    console.log("  PASS " + label);
  } else {
    fail++;
    console.log("  FAIL " + label + (detail ? "  -> " + detail : ""));
  }
}

// ---- schema + prune ----
M.ensureSchema(sql);
check("ensureSchema runs idempotent", true);

// A tool card is part of the transcript, not only the live stream.
const persistedTools = JSON.stringify([
  { name: "lookup_online", cmd: "latest AI news", output: "3 results", ok: true },
]);
M.logMessage(sql, "assistant", "Here are the results", "primary", persistedTools);
const persistedRows = M.recentMessages(sql, 1);
check(
  "logMessage persists tool cards on the assistant row",
  persistedRows[0]?.tools_json === persistedTools,
  `got ${JSON.stringify(persistedRows[0]?.tools_json)}`
);

// Seed a legacy backlog the way the OLD behavior would have left it.
sql.exec(
  "INSERT INTO tasks (title,status,due_at,payload,created_at,recurrence) VALUES (?,?,?,?,?,?)",
  "served one-off A", "done", 1000, "", 500, null
);
sql.exec(
  "INSERT INTO tasks (title,status,due_at,payload,created_at,recurrence) VALUES (?,?,?,?,?,?)",
  "daily that went done", "done", 1000, "", 500, "daily:08:00"
);
// A fired one-off under the NEW code is deleted at the tick, but any row still
// sitting 'done' with no recurrence must be pruned on the next schema touch.
M.ensureSchema(sql);
const afterPrune = sql.exec("SELECT title,status,recurrence FROM tasks ORDER BY title").results;
check(
  "legacy done one-off pruned",
  !afterPrune.some((r) => r.title === "served one-off A"),
  JSON.stringify(afterPrune)
);
check(
  "done WITH recurrence is NOT pruned (safety)",
  afterPrune.some((r) => r.title === "daily that went done"),
  JSON.stringify(afterPrune)
);
check("pending/running survive prune", true); // none pending seeded yet

// ---- text recall (#26) ----
const t0 = Date.now();
M.remember(sql, "user", "the user is Youssef and lives in Rabat", 5);
M.remember(sql, "preference", "prefers terse French answers", 3);
M.remember(sql, "random", "a low-value note", 1);
// ensure distinct timestamps for the recency tiebreak
const memRows = sql.exec("SELECT id FROM memories ORDER BY id").results;
if (memRows.length >= 2)
  sql.exec("UPDATE memories SET updated_at=? WHERE id=?", t0 + 1000, memRows[1].id);

const r1 = M.recall(sql, "Rabat", 8);
check("recall finds memory by substring", r1.some((m) => /Rabat/.test(m.content)), JSON.stringify(r1.map((m) => m.content)));

const r2 = M.recall(sql, "rabat", 8);
check("recall is case-insensitive (ASCII)", r2.some((m) => /Rabat/.test(m.content)), JSON.stringify(r2.map((m) => m.content)));

const r3 = M.recall(sql, "%", 8);
check("LIKE metacharacters in query are escaped (no wild match)", r3.length === 0 || r3.every((m) => m.content.includes("%")), JSON.stringify(r3.map((m) => m.content)));

const r4 = M.recall(sql, "nonexistent-xyzzy", 8);
check("recall returns [] on no match", Array.isArray(r4) && r4.length === 0, JSON.stringify(r4));

const top = M.recall(sql, "", 8);
check("empty query returns memories ordered by importance desc", top.length >= 3 && top[0].importance >= top[1].importance && top[0].importance === 5, JSON.stringify(top.map((m) => m.importance)));

// ---- one-off lifecycle: pending -> (would be deleted) ----
M.enqueueTask(sql, "reminder", Date.now() - 1, "do the thing", null);
M.enqueueTask(sql, "daily standup", Date.now() + 10_000, "post standup", "daily:09:00");
const due = M.dueTasks(sql, Date.now());
check("dueTasks returns only due+pending one-off", due.length === 1 && due[0].title === "reminder", JSON.stringify(due.map((d) => d.title)));
// Simulate the new retire branch (what onScheduledTask now does for one-offs):
const oneoffId = due[0].id;
sql.exec("DELETE FROM tasks WHERE id = ?", oneoffId);
const remaining = sql.exec("SELECT title,status FROM tasks ORDER BY title").results;
check("served one-off is gone from tasks table", !remaining.some((r) => r.title === "reminder"), JSON.stringify(remaining));
check("daily remains pending (re-armed by tick, not deleted here)", remaining.some((r) => r.title === "daily standup" && r.status === "pending"), JSON.stringify(remaining));

db.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
