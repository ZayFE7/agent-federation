import { spawnSync } from "node:child_process";

function put(name, value) {
  const r = spawnSync(
    "C:\\npx.cmd",
    ["wrangler", "secret", "put", name, "-c", "deploy/sandbox-worker/wrangler.jsonc"],
    {
      input: value,
      encoding: "utf8",
      cwd: "E:/Users/Zay L/agent-federation",
      stdio: ["pipe", "inherit", "inherit"],
    }
  );
  console.log(name, "exit", r.status);
}

put("E2B_API_KEY", "e2b_d1f3a042f9686ce66801324d5b660cad8859d428");
put("SBOX_TOKEN", "642a40366a3176e771f714ae9bd4f079");
