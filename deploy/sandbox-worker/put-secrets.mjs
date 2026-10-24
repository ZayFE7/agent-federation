import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const E2B_API_KEY = process.env.E2B_API_KEY;
const SBOX_TOKEN = process.env.SBOX_TOKEN;

if (!E2B_API_KEY || !SBOX_TOKEN) {
  console.error("Set E2B_API_KEY and SBOX_TOKEN in the environment before running this script.");
  process.exit(1);
}

const cwd = process.env.BLIP_DEPLOY_DIR || process.cwd();
const config = resolve(cwd, "deploy/sandbox-worker/wrangler.jsonc");
if (!existsSync(config)) {
  console.error("Run this from the deploy tree, or set BLIP_DEPLOY_DIR to that tree.");
  process.exit(1);
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function put(name, value) {
  const r = spawnSync(
    npx,
    ["wrangler", "secret", "put", name, "-c", config],
    {
      input: value,
      encoding: "utf8",
      cwd,
      stdio: ["pipe", "inherit", "inherit"],
    }
  );
  if (r.status !== 0) {
    console.error(`${name} was not updated`);
    process.exit(r.status ?? 1);
  }
  console.log(name, "updated");
}

put("E2B_API_KEY", E2B_API_KEY);
put("SBOX_TOKEN", SBOX_TOKEN);
