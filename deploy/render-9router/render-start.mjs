// Render start wrapper: restore 9router state from the federation vault,
// run 9router on $PORT, push state back on an interval and on shutdown.
// HOME is redirected into the project dir so ~/.9router lives on the
// Render instance disk; persistence is handled by the vault, not the disk.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const VAULT = process.env.VAULT_URL;
const STATE_KEY = process.env.STATE_KEY;
const PORT = process.env.PORT || "10000";
const INTERVAL = Number(process.env.SYNC_INTERVAL || 180);
const VAULT_KEY = "data.sqlite";
const CHUNK = 1_400_000;

const home = process.cwd();
process.env.HOME = home;
const DB = path.join(home, ".9router", "db", "data.sqlite");

const log = (...a) => console.log("[sync]", ...a);

if (!VAULT || !STATE_KEY) {
  log("WARNING: VAULT_URL/STATE_KEY missing; no state sync");
}

const headers = { authorization: `Bearer ${STATE_KEY || ""}` };

async function pull() {
  const metaRes = await fetch(`${VAULT}/internal/vault/health?key=${VAULT_KEY}`, { headers });
  if (metaRes.status === 404) {
    log("no remote state yet");
    return false;
  }
  if (!metaRes.ok) return false;
  const meta = await metaRes.json();
  const total = Number(meta.total || 0);
  if (!total) return false;
  const parts = [];
  for (let idx = 0; idx < total; idx++) {
    const res = await fetch(`${VAULT}/internal/vault/chunk?key=${VAULT_KEY}&idx=${idx}`, { headers });
    if (!res.ok) {
      log(`chunk ${idx} failed: ${res.status}`);
      return false;
    }
    parts.push(await res.text());
  }
  const buf = Buffer.concat(parts.map((p) => Buffer.from(p, "base64")));
  await mkdir(path.dirname(DB), { recursive: true });
  await writeFile(DB, buf);
  log(`restored ${buf.length} bytes in ${total} chunks`);
  return true;
}

async function push() {
  if (!VAULT || !STATE_KEY) return false;
  let buf;
  try {
    buf = await readFile(DB);
  } catch {
    return false;
  }
  const total = Math.ceil(buf.length / CHUNK) || 1;
  for (let idx = 0; idx < total; idx++) {
    const slice = buf.subarray(idx * CHUNK, Math.min((idx + 1) * CHUNK, buf.length));
    const res = await fetch(`${VAULT}/internal/vault/push`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ key: VAULT_KEY, idx, total, dataB64: slice.toString("base64") }),
    });
    if (!res.ok) {
      log(`push chunk ${idx} failed: ${res.status}`);
      return false;
    }
  }
  log(`pushed ${buf.length} bytes in ${total} chunks`);
  return true;
}

if (VAULT && STATE_KEY) {
  await pull().catch((e) => log(`pull error: ${e}`));
  setInterval(() => {
    push().catch((e) => log(`push error: ${e}`));
  }, INTERVAL * 1000);
}

const bin = path.join(home, "node_modules", ".bin", "9router");
const child = spawn(bin, ["--port", PORT, "--no-browser", "--skip-update"], {
  stdio: "inherit",
  env: process.env,
});

function shutdown(signal) {
  log(`signal ${signal}; final push then exit`);
  push()
    .catch(() => {})
    .finally(() => {
      child.kill(signal);
      setTimeout(() => process.exit(0), 2000);
    });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

child.on("exit", (code) => {
  push().finally(() => process.exit(code ?? 0));
});
