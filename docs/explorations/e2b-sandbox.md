# E2B sandbox (`zay-sandbox`) — architecture exploration

## Scope

The `zay-sandbox` Cloudflare Worker (`deploy/sandbox-worker/src/index.ts`, 173 lines) that owns every E2B
microVM, plus the brain-side call sites in `src/agent.ts`: `execSandbox` (`src/agent.ts:468-503`), the
`save_workspace` tool (`src/agent.ts:658-663`, handler `src/agent.ts:822-840`), the deterministic `run:`
short-circuit (`src/agent.ts:536-548`) and `approveAction` (`src/agent.ts:274-309`). Also the risk gate
(`src/guardrails.ts:15-52`) and the service binding topology (`wrangler.jsonc:11-14`,
`deploy/sandbox-worker/wrangler.jsonc`).

Out of scope: router, UI, memory, cron — other analysts cover those.

External references used (official E2B docs + SDK reference + known SDK bug):
- Sandbox lifecycle: <https://docs.e2b.dev/sandbox>
- Persistence (pause/resume/snapshots): <https://docs.e2b.dev/sandbox/persistence>
- Auto-resume on request: <https://docs.e2b.dev/sandbox/auto-resume>
- Commands: <https://docs.e2b.dev/commands>
- Filesystem API: <https://docs.e2b.dev/filesystem>
- JS SDK reference (v1.x, repo pins `e2b: ^1.5.0`):
  <https://docs.e2b.dev/sdk-reference/js-sdk/v1.3.0/sandbox>
- `commands.run` can hang when a sandbox is unreachable because the stream call gets no read/write
  timeout: <https://github.com/e2b-dev/e2b/issues/1128>

Key doc facts this analysis leans on: `Sandbox.create` default `timeoutMs` is 300 000 (5 min) and the lease
is measured from creation, not refreshed by activity; `pause`/`resume` (via `Sandbox.connect(id)`) preserve
filesystem **and** memory and are retained indefinitely; auto-resume wakes a paused sandbox and gives it the
original timeout or a 5-minute floor; E2B exposes a real `files` API (`write`/`read`, binary) and PTY, neither
of which `zay-sandbox` uses.

## Current behavior (file:line)

- **Auth is global and first.** Every request, including `/health`, is compared to
  `Bearer ${env.SBOX_TOKEN}` before routing (`deploy/sandbox-worker/src/index.ts:75-77`, then
  `:79-81/:83/:99/:118`). A missing/wrong token gets `401` and nothing else runs.
- **Endpoint map.** `GET /health` `:79`, `POST /session/kill` `:83`,
  `POST /workspace/snapshot` `:99`, `POST /run` `:118`, else 404 `:171`. There is no
  route/`workers_dev` block in `deploy/sandbox-worker/wrangler.jsonc`, so in practice the worker
  is reached only through the brain's service binding (`wrangler.jsonc:13`) — not a public hostname.
- **Session pooling / boot.** `poolGet(sessionId)` (`:30-70`) reads KV `SESSIONS[sessionId]`,
  tries `Sandbox.connect(hit.id)` (`:34`), on failure deletes the entry (`:36`) and falls through to
  `createSandbox` → `Sandbox.create({template:"base", timeoutMs:300_000})` (`:22-28`). On a fresh
  boot it runs two extra commands: the `python` symlink (`:43-46`) and the workspace restore
  (`:52-63`), then writes `{id}` to KV with `expirationTtl:600` (`:64-68`).
- **The exit-127 fix.** Boot creates `python -> python3` best-effort with `onError:()=>{}` and
  `|| true` (`:43-49`). `/run` passes `onError:()=>{}` (`:137`) so a non-zero exit does **not** throw,
  letting `:140-146` return real `stdout/stderr/exitCode`. A second catch reconstruction
  (`:147-162`) still salvages a `CommandExitError` (`err.exitCode/stdout/stderr`) into a `200`.
- **Persistence.** `/workspace/snapshot` tars `/workspace`, base64-inlines it into a shell string and
  stores the base64 as one KV value `ws:tar:<sid>` (`:108-115`). Restore pipes that value back through
  `echo '<b64>' | base64 -d | tar xzf -` (`:54-57`). `/session/kill` deletes only the session entry,
  leaving `ws:tar:<sid>` behind.
- **Brain contract.** `execSandbox` posts `/run` with `sessionId:"agent"` (`src/agent.ts:479`), maps a
  `200` into `exit 0 (success)` / `command FAILED with exit N` + clipped stdout(4000)/stderr(1500)
  (`src/agent.ts:487-499`), and turns a non-OK HTTP response into `sandbox infrastructure error (<status>)`
  (`src/agent.ts:494-497`). `save_workspace` posts `/workspace/snapshot` with `sessionId:"agent"`
  (`src/agent.ts:827-840`). `run:` bypasses `isRisky` by design (`src/agent.ts:539-544`,
  `src/guardrails.ts:12-13`); model-emitted `exec` is gated (`src/agent.ts:851-864`).

## Problems & risks

### The exit-127 fix — is it sound?

**Partially sound, but the stated mechanism is wrong and the `python` premise is unverified.**

- [Major] The code comment (`deploy/sandbox-worker/src/index.ts:132-133`) claims `onError:()=>{}` is what
  "swallows the throw on non-zero exit." In the E2B JS SDK `onError` is a **stream-error callback**, not an
  exit-code suppressor; a non-zero exit raises `CommandExitError` from the promise, which is thrown at the
  top level. The reason `/run` actually works is the redundant **catch-reconstruction** at
  `:147-162` (it re-reads `err.exitCode/stdout/stderr` and returns 200). This is a genuine belt-and-suspenders
  win — but the design intent in the comment is misleading, and if a future refactor removes the catch as
  "dead code" the fix silently regresses to swallowing stderr. Verify against the pinned SDK version and
  fix the comment.
- [Major] The `python` alias is created **only inside `poolGet`, only on a fresh boot**
  (`deploy/sandbox-worker/src/index.ts:42-49`). Two holes: (a) `Sandbox.connect` to an existing pooled VM
  skips it entirely (`:33-37`) — that path assumes the alias already exists, which holds only if the VM was
  ever created by this worker; (b) it depends on `command -v python3` resolving in the `base` template.
  If `base` ships python under a venv/`/usr/bin/python3.x` with no `python3` on `PATH`, `ln -sf "" ...`
  yields a broken symlink and exit 127 returns for `python --version`. The comment's premise ("base ships
  python3") should be confirmed on the deployed template, and the alias made idempotent + present on the
  connect path too.
- [Minor] Boot adds **two serial `commands.run` round-trips** per cold start (`:43`, `:54`) — extra latency
  and extra failure surface on the path the user waits on.

### Persistence model — this is the weakest part

- [Critical] **Two hard ceilings, and the smaller one hits first.** A base64 tar is stored as a single KV
  value (`deploy/sandbox-worker/src/index.ts:114`). Workers KV caps one value at ~25 MiB, and base64 inflates
  by ~1.33×, so the gzipped tar must stay under roughly ~18 MB. But restore inlines the whole payload into a
  **shell argument** (`echo '<tar>' | …`, `:54-57`), which is bound by Linux `ARG_MAX` (~2 MiB by default) via
  `execve`. So a workspace whose gzipped tar exceeds ~1–2 MB fails to restore long before the KV limit — and
  `npm install` / `pip install` / datasets / `node_modules` blow past 2 MB gzipped trivially. Real workspaces
  are silently un-persistable.
- [Critical] **Silent data loss on restore.** The restore block swallows **every** error
  (`deploy/sandbox-worker/src/index.ts:61-63` — `catch { /* no snapshot yet */ }`). A corrupt base64, an
  `E2BIG`, a partial tar, or a `tar` failure are indistinguishable from "no snapshot exists": `poolGet`
  proceeds with an empty `/workspace` and the caller never learns their files are gone.
- [Major] **Silent data loss on snapshot too.** `SESSIONS.put` (`:114`) is not wrapped; an over-limit value
  throws an unhandled error → the DO call rejects → generic tool error to the model. Also the tar's `stdout`
  is materialized fully in the Worker isolate (`:108-112`) — a multi-hundred-MB workspace risks the
  128 MB Worker memory ceiling before it ever reaches KV.
- [Major] **Wrong tool for the job.** E2B has first-class persistence that preserves filesystem *and*
  memory indefinitely and resumes by id (`<https://docs.e2b.dev/sandbox/persistence>`,
  `<https://docs.e2b.dev/sandbox/auto-resume>`). The KV-base64-tar path reinvents it badly. R2 (no per-object
  size cliff at these scales, ~5 GB multipart) is the correct storage tier if a tar pipeline is kept;
  `sandbox.pause()` + `Sandbox.connect()` is the correct model if session continuity is wanted.

### Correctness — leases, timeouts, endpoints

- [Major] **KV TTL (600 s) outlives the VM lease (300 s), and the lease is never extended.**
  `POOL_TTL=600` (`deploy/sandbox-worker/src/index.ts:13`) vs `timeoutMs:300_000` (`:12,:26`).
  `keepWarm()` (`:128-131`) refreshes only the KV entry on each `/run`; it does **not** call
  `sbx.setTimeout()`. Because E2B measures the lease from creation (not per-activity), an actively used
  session's VM still dies at 300 s while the KV entry still points at it for another 300 s → the next call
  fails `connect`, recreates a fresh VM, and restores from the (possibly stale) snapshot — losing anything
  not explicitly `save_workspace`d. The pool "reuse window" is largely fiction past 5 minutes.
- [Major] **Create race / orphaned VMs.** `poolGet` is check-then-act with no lock
  (`deploy/sandbox-worker/src/index.ts:31-68`). Two concurrent `/run` calls for the same `sessionId`
  (e.g. the `run:` path and a background cron job firing while the user chats) both miss KV, both
  `Sandbox.create`, both `put` — last writer wins, the first VM is orphaned (billed, and unreachable via
  `/session/kill` which only knows the surviving id). On a 20-concurrent free-tier cap a few of these
  exhaust the quota.
- [Minor] **60 s command timeout vs Worker/DO wall clock.** `commands.run(...,{timeoutMs:60_000})`
  (`:135-136`) is awaited inside a service-binding request from the Durable Object. Cloudflare requests to
  another Worker and the browser fetch have their own deadlines; a legitimate 40–60 s command plus a 300 s
  cold boot in one fetch can be cut off upstream before E2B ever times out. And `run:`/cron have no way to
  express a job longer than 60 s at all (`:135`).
- [Minor] **`commands.run` can hang on an unreachable sandbox.** Known E2B behavior: the streaming call
  doesn't apply a read timeout (`<https://github.com/e2b-dev/e2b/issues/1128>`). A dead-but-KV-referenced VM
  can stall `/run` past the intended `timeoutMs`; only an upstream deadline saves it. Pass an explicit
  `requestTimeoutMs` and/or wrap the fetch.
- [Minor] **Inconsistent `sessionId` defaults across endpoints.** `/run` and `/session/kill` default to
  `"default"` (`:85,:121`) but `/workspace/snapshot` defaults to `"agent"` (`:101`). The brain always
  sends `"agent"` (`src/agent.ts:479,:833`), so today it is consistent — but any caller that omits
  `sessionId` snapshots into `ws:tar:agent` while running in `default`, silently splitting state.
- [Minor] **Snapshot tar lacks the `/run` hardening.** `/workspace/snapshot` runs its tar with **no**
  `onError` and **no** try/catch (`:108-112`); a genuinely failing tar yields a raw 500, unlike the careful
  path at `:134-168`. (`|| base64` masks `tar`'s exit code via pipe semantics, so this is lower-likelihood
  but inconsistent.)
- [Minor] **KV snapshot never expires / never cleaned.** `ws:tar:<sid>` is written with no TTL (`:114`) and
  `/session/kill` deletes only `sessionId`, not `ws:tar:<sid>` (`:83-97`) — stale workspace blobs accumulate
  forever in KV.

### Security

- [Major] **Arbitrary shell = RCE by design; the only gate is a regex.** The sandbox is a full Linux VM
  with internet egress. The blast radius of a *model-emitted* command is bounded only by
  `isRisky` (`src/guardrails.ts:15-52`), a lowercase regex blocklist trivially bypassed by
  obfuscation (`rm` via `$(echo …)`, `python -c "import shutil…"`, `base64 -d|sh`, splitting on `;`).
  `run:` intentionally bypasses the gate (`src/agent.ts:539-544`) — correct for a human, but means anything
  that can inject into the chat string (`content` reaches the same `DIRECT_RUN_RE`) is human-equivalent RCE.
- [Good] **No secrets inside the VM.** `E2B_API_KEY` and `SBOX_TOKEN` stay in the Worker isolate;
  `commands.run` is never passed an `envs` field (`:43,:54,:108,:135`), so nothing sensitive is exposed to
  model-controlled shell. Keep it that way — do not start forwarding env into the VM.
- [Major] **No egress / SSRF policy.** The VM can reach the public internet and, being a Cloudflare-deployed
  caller, can be pointed at internal/metadata services; `curl <anything>` isn't blocked (only `curl|sh` is
  in `guardrails.ts:37`). Data exfiltration and abuse (spam, mining, scraping) are unrestricted.
- [Minor] **Shared static bearer, non-constant-time compare.** One `SBOX_TOKEN` for all callers, compared
  with `!==` (`deploy/sandbox-worker/src/index.ts:75`). No rotation, no per-session/per-user tokens, no
  audit trail. Fine while only the service binding reaches it; a footgun the moment a public route is added.

### Robustness

- [Major] **Error surfacing is good on `/run`, weak on boot/persistence.** `execSandbox` faithfully shows
  stdout+stderr+exitCode and a "read stderr" hint (`src/agent.ts:487-493`), and infra failures as
  `sandbox infrastructure error (<status>)` (`src/agent.ts:494-497`). But cold-boot and restore failures are
  swallowed (`deploy/sandbox-worker/src/index.ts:47-49,:61-63`), so the user sees an empty workspace, not an
  outage.
- [Minor] **Cold-boot latency/cost on the critical path.** Every >5-min gap re-runs create + symlink +
  restore serially before the first real command returns. Free tier caps 20 concurrent VMs and 1 h/session
  (`deploy/sandbox-worker/README.md:52-58`); orphaned VMs (above) and the missing lease-extension eat that
  budget.
- [Minor] **E2B outage degrades to text, no retry/backoff.** `Sandbox.create/connect` throws →
  `502 "boot: …"` → model sees `sandbox infrastructure error (502)` and can retry only at the LLM layer.
  Reasonable, but no circuit breaker; a hard E2B outage makes every `exec` call a full boot timeout + 502.

### Capabilities the model cannot use today

- **Interactive / PTY sessions** (`sandbox.pty`) — none exposed; `/run` is fire-and-forget one-shot only
  (`deploy/sandbox-worker/src/index.ts:118-169`). No REPLs, no TUI, no vim-style flows.
- **Background / long jobs** (>60 s) — the `background` option of `commands.run` and a job-status endpoint
  are unused; hard 60 s cap (`:136`). No dev servers, `npm run build`, training, downloads.
- **Real file upload/download** — the E2B `files` API (`<https://docs.e2b.dev/filesystem>`) is bypassed in
  favor of `echo|base64|tar` hacks; no `/files` proxy, so the model can't move a 40 MB CSV or read a PNG
  without shelling base64 through stdout.
- **Port exposure / preview URLs** — `getHost()`/preview URLs not surfaced; a sandbox web server is
  unreachable to the user.
- **Network egress policy** — all-or-nothing; no domain allowlist.
- **GPU** — E2B has no GPU SKUs; any `cuda`/`torch` GPU request cannot be served here (scope the model's
  expectations accordingly).

## Near-term improvements

1. **Stop the silent data loss (Critical).** (a) Wrap restore so a *failed-but-nonempty* snapshot surfaces an
   error instead of an empty `/workspace`: distinguish "no `ws:tar` key" from "restore command failed" and
   return that to the caller (`deploy/sandbox-worker/src/index.ts:51-63`). (b) Move the payload out of the
   shell argument — pipe via `sandbox.files.write` of the decoded bytes, or `commands.run` with
   `stdin: tarGzipBuffer` (the SDK accepts binary stdin) — to dodge `ARG_MAX`. (c) Add an explicit size guard
   before `tar|base64` and before `SESSIONS.put`, returning a clear "workspace too large for KV snapshot"
   error.
2. **Extend the lease in `keepWarm`.** Call `sbx.setTimeout(BOOT_TIMEOUT_MS/1000)` alongside the KV
   `put` (`deploy/sandbox-worker/src/index.ts:128-131`) so an active session's VM does not die at the fixed
   300 s ceiling; or adopt E2B auto-pause/auto-resume so an idle VM pauses and resumes with full state.
3. **Serialize pool creation.** Guard the create path with a short-lived KV lock or an DO-local in-flight
   `Map<sessionId, Promise<Sandbox>>` to collapse concurrent boots and stop orphaning VMs
   (`deploy/sandbox-worker/src/index.ts:31-68`).
4. **Fix the misleading comment + make the alias robust.** Correct the `onError` claim
   (`deploy/sandbox-worker/src/index.ts:132-133`), verify `python3` resolves on the deployed `base`
   template, and run the symlink check on the connect path too.
5. **Pass `requestTimeoutMs` to `commands.run`** and wrap the connect/run in an AbortController timeout so a
   dead VM can't hang the Worker (`<https://github.com/e2b-dev/e2b/issues/1128>`).
6. **Harden the snapshot endpoint** to use the same `onError`/try-catch shape as `/run` and add a TTL to
   `ws:tar:<sid>`; delete it in `/session/kill` (or keep it intentionally and document that).

## Next features

- **Native E2B persistence (replaces KV-tar).** Pause/idle + resume the VM by id instead of tar-ing to KV:
  filesystem+memory continuity, resumes by `Sandbox.connect`, retained indefinitely.
  *Why:* kills the entire persistence bug class and preserves installed packages/state, not just files.
  *Sketch:* on session end (or a new `/session/pause`), `sbx.pause()`; store `sandboxId` with a long TTL;
  `poolGet` resumes. Keep KV only for the id→sandboxId map, never the tar.
  *Effort:* M. *Depends on:* paid E2B (persistence/auto-resume tier); verify 1 h free-tier cap interaction.
  *Risk:* resume latency; auto-resume timeout semantics (`<https://docs.e2b.dev/sandbox/auto-resume>`).
- **R2-backed workspace snapshots (interim).** If tar stays, store the gzip in R2 (multipart, GB-scale) and
  restore via `sandbox.files`/stdin, not a shell arg. *Why:* lifts the 2 MB/25 MB cliffs immediately with
  no E2B-plan change. *Effort:* M. *Depends:* add R2 binding to `deploy/sandbox-worker/wrangler.jsonc`.
  *Risk:* still lossy for memory/`/tmp` state.
- **Baked custom template.** Build a template with the `python` alias, common CLIs, and pinned files so
  boot needs zero setup commands. *Why:* removes 2 serial boot commands, fixes exit-127 at the source,
  cuts cold-boot latency. *Effort:* S–M (needs E2B template build in CI). *Depends:* template build access.
  *Risk:* template staleness vs `base`.
- **File proxy endpoints (`/files`, `/upload`, `/download`).** Thin wrapper over `sandbox.files`
  (`<https://docs.e2b.dev/filesystem>`) so tools move bytes without `echo|base64`. *Why:* unlocks real data
  work and image/binary handling. *Effort:* M. *Depends:* auth model per file. *Risk:* large streams through
  the Worker isolate (stream, don't buffer).
- **Background jobs + PTY.** Add `background:true` run with a job handle, `/job/status`, `/job/logs`, and a
  `sandbox.pty` session for interactive programs. *Why:* builds, servers, REPLs, >60 s jobs. *Effort:* L
  (lifecycle, session affinity, polling/streaming). *Depends:* persistence feature so the VM survives.
  *Risk:* orphaned processes, cost.
- **Egress allowlist + least-privilege user.** Run commands as non-root, default-deny outbound with a small
  allowlist; make `isRisky` a hint rather than the sole control. *Why:* defense-in-depth against prompt
  injection and exfil. *Effort:* M. *Risk:* breaking legitimate installs that need to fetch packages.
- **Preview URLs (`getHost`).** Surface a sandbox port to the user for web-app workflows. *Effort:* S–M.
  *Depends:* session continuity. *Risk:* public URL exposure.

## Open questions for the user

1. E2B plan: is this staying on the free/no-card tier (1 h/session, 20 concurrent), or will you enable paid
   persistence/auto-resume so native `pause`/`resume` and R2 are viable? This decides whether persistence is
   "fix the tar" or "delete the tar".
2. What actually lives in `/workspace`, and its realistic size? (Determines whether the `ARG_MAX`/25 MB
   cliffs are today's bug or a future one.)
3. Should the sandbox be internet-egress-open by design, or do you want a default-deny allowlist now?
4. Is the `run:` human short-circuit expected to be the *only* human-driven exec, or will trusted users send
   arbitrary shell — i.e., how much do we rely on `isRisky`?
5. Do you need interactive/long-running jobs (servers, builds, training) soon? That gates the PTY/background
   roadmap and forces the persistence work first.
6. Confirm the deployed `base` template ships `python3` resolvable on `PATH` (the symlink fix assumes it);
   if not, a custom baked template is required before exit-127 is truly gone.
7. Is `zay-sandbox` ever going to get a public route/hostname? If so the shared static `SBOX_TOKEN` and
   non-constant-time compare need upgrading.
