// Sync /app/data/db/data.sqlite to the federation worker's state vault.
// Usage: node sync.mjs pull | push | loop
// Env: VAULT_URL, STATE_KEY, SYNC_INTERVAL (seconds, for loop mode)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const VAULT = process.env.VAULT_URL;
const STATE_KEY = process.env.STATE_KEY;
const FILE = process.env.DB_FILE || "/app/data/db/data.sqlite";
const VAULT_KEY = process.env.VAULT_KEY || "data.sqlite";
const INTERVAL = Number(process.env.SYNC_INTERVAL || 180);
const CHUNK = 1_400_000; // raw bytes per chunk; base64 stays under DO 2MB row cap

if (!VAULT || !STATE_KEY) {
  console.error("[sync] VAULT_URL and STATE_KEY are required");
  process.exit(1);
}

const headers = { authorization: `Bearer ${STATE_KEY}` };

async function pull() {
  const metaRes = await fetch(`${VAULT}/internal/vault/health?key=${VAULT_KEY}`, { headers });
  if (metaRes.status === 404) {
    console.log("[sync] no remote state yet (first deploy?)");
    return false;
  }
  if (!metaRes.ok) {
    console.error(`[sync] health failed: HTTP ${metaRes.status}`);
    return false;
  }
  const meta = await metaRes.json();
  const total = Number(meta.total || 0);
  if (!total) {
    console.log("[sync] vault empty");
    return false;
  }
  const parts = [];
  for (let idx = 0; idx < total; idx++) {
    const res = await fetch(`${VAULT}/internal/vault/chunk?key=${VAULT_KEY}&idx=${idx}`, { headers });
    if (!res.ok) {
      console.error(`[sync] chunk ${idx} failed: HTTP ${res.status}`);
      return false;
    }
    parts.push(await res.text());
  }
  // Chunks are independently base64-encoded (each carries its own padding),
  // so decode per chunk; a single decode of the joined string stops at the
  // first interior '='.
  const buf = Buffer.concat(parts.map((p) => Buffer.from(p, "base64")));
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, buf);
  console.log(`[sync] restored ${buf.length} bytes in ${total} chunks`);
  return true;
}

async function push() {
  const buf = await readFile(FILE);
  const total = Math.ceil(buf.length / CHUNK) || 1;
  for (let idx = 0; idx < total; idx++) {
    const slice = buf.subarray(idx * CHUNK, Math.min((idx + 1) * CHUNK, buf.length));
    const res = await fetch(`${VAULT}/internal/vault/push`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        key: VAULT_KEY,
        idx,
        total,
        dataB64: slice.toString("base64"),
      }),
    });
    if (!res.ok) {
      console.error(`[sync] push chunk ${idx}/${total} failed: HTTP ${res.status}`);
      return false;
    }
  }
  console.log(`[sync] pushed ${buf.length} bytes in ${total} chunks`);
  return true;
}

const mode = process.argv[2];
if (mode === "pull") {
  pull().then((ok) => process.exit(ok ? 0 : 1));
} else if (mode === "push") {
  push().then((ok) => process.exit(ok ? 0 : 1));
} else if (mode === "loop") {
  setInterval(() => {
    push().catch((e) => console.error(`[sync] push error: ${e}`));
  }, INTERVAL * 1000);
  process.on("SIGTERM", () => {
    push().then(() => process.exit(0));
  });
} else {
  console.error("usage: node sync.mjs pull|push|loop");
  process.exit(1);
}
