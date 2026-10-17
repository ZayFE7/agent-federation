# deploy/sandbox-worker (zay-sandbox)

E2B burst code execution behind a single shared secret: a thin Cloudflare Worker that
boots or reuses an E2B microVM, runs one shell command in it, and returns
`{stdout, stderr, exitCode, sandboxId}`. This is what makes BLIP's `exec` and
`save_workspace` tools real rather than promised.

All requests are gated on `Authorization: Bearer <SBOX_TOKEN>`; a wrong or absent token
gets `401 {error:"unauthorized"}` before any routing happens (`src/index.ts:65-67`), and
`/health` therefore also answers 401 without it (`src/index.ts:69-71`).

## Routes (`src/index.ts`)

| Route | Line | Behaviour |
|---|---|---|
| `GET /health` | 69 | `{ok:true, service:"zay-sandbox"}` |
| `POST /session/kill` | 73 | connects and kills the pooled VM, drops the KV entry |
| `POST /workspace/snapshot` | 89 | `tar czf - . \| base64 -w0` in `/workspace`, stores base64 in KV under `ws:tar:<sid>` |
| `POST /run` | 108 | body `{cmd, sessionId?}`; `sbx.commands.run(cmd, {timeout: 60})`, renews the pool entry |
| anything else | 138 | 404 |

Session pooling: `poolGet()` (`src/index.ts:30-60`) looks up the session id in KV, tries
`Sandbox.connect`, falls back to `Sandbox.create` with template `base`, and on a fresh
boot restores the last snapshot into `/workspace`. Lease knob `BOOT_TIMEOUT_MS` is 300 000
ms (`:12`) and the reuse window `POOL_TTL` is 600 s (`:13`).

## Who calls it

The brain, never the UI. `src/agent.ts:455-465` posts `/run` through the `SANDBOX` service
binding with `Bearer SBOX_TOKEN` and `sessionId: "agent"`; `src/agent.ts:435-445` posts
`/workspace/snapshot` the same way. Both short-circuit to `sandbox not configured` when the
binding is missing. The binding is declared at `../../wrangler.jsonc:13`.

## Env it needs

`E2B_API_KEY` and `SBOX_TOKEN` (`src/index.ts:6-10`); `SBOX_TOKEN` must match the value set on
the brain. Neither name appears in `.dev.vars`, `.dev.vars.example`, or the root
`wrangler.jsonc` vars block, although both are listed by name in
`_superseded/secrets-checklist.md`. Names only: no value for either exists anywhere in this repo.

## Blockers

1. **`e2b` is not installed.** `package.json:6` declares `e2b: ^1.5.0` and `src/index.ts:4`
   imports `Sandbox` from it, but the root `node_modules/` has no `e2b` and this directory
   has no install of its own. Nothing here builds or deploys as pulled.
2. `wrangler.jsonc:7` carries KV id `6bc0d1ad878542c69cd6e8bf545d2d7d` for binding
   `SESSIONS`, an old-account resource to verify or recreate.
3. No `tsconfig.json`, so this worker is never typechecked (`../../tsconfig.json:14` only
   includes `src`).

## Why it is burst-only (locked historical finding)

E2B's free/no-card trial caps a session at 1 hour, gives 20 concurrent sandboxes and
2 vCPU/1 GB, and Playwright needs a custom template. That was verified on the old PC and
recorded in `../../../memory/personal-agent-project.md` (line 11): "free + no card +
always-on + full VM does not exist". So zay-sandbox can only serve short command bursts,
not a persistent Linux box; workspace continuity is faked through the KV snapshot path
above. `../../../../GAPS.md` carries the full list.

## Not verified

Whether the deployed `zay-sandbox` currently responds (an external check reported
"alive behind `SBOX_TOKEN`, 401 without token" on 2026-10-16, `_superseded/HANDOFF.md`),
and whether the base64-tar snapshot restore at `src/index.ts:44-49` survives large
workspaces: that command inlines the whole payload into a shell string.
