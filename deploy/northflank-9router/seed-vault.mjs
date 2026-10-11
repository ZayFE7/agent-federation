// One-time local seed: upload %APPDATA%/9router/db/data.sqlite into the vault.
// Env: VAULT_URL, STATE_KEY. Optional: SOURCE_DB to override the sqlite path.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const VAULT = process.env.VAULT_URL;
const STATE_KEY = process.env.STATE_KEY;
const SOURCE =
  process.env.SOURCE_DB ||
  join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "9router", "db", "data.sqlite");
const VAULT_KEY = process.env.VAULT_KEY || "data.sqlite";
const CHUNK = 1_400_000;

if (!VAULT || !STATE_KEY) {
  console.error("VAULT_URL and STATE_KEY required");
  process.exit(1);
}

const buf = await readFile(SOURCE);
const total = Math.ceil(buf.length / CHUNK);
console.log(`seeding ${SOURCE} (${buf.length} bytes, ${total} chunks) -> ${VAULT}`);

for (let idx = 0; idx < total; idx++) {
  const slice = buf.subarray(idx * CHUNK, Math.min((idx + 1) * CHUNK, buf.length));
  const res = await fetch(`${VAULT}/internal/vault/push`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${STATE_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ key: VAULT_KEY, idx, total, dataB64: slice.toString("base64") }),
  });
  if (!res.ok) {
    console.error(`chunk ${idx} failed: HTTP ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log(`chunk ${idx + 1}/${total} ok`);
}
console.log("SEED COMPLETE");
