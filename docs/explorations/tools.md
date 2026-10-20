# BLIP tool-surface audit (function-calling + deterministic short-circuits)

READ-ONLY exploration report. All line refs are repo-relative to `repo-clone/`.

## Scope

Everything the model can invoke, plus the two deterministic human short-circuits that bypass
the model entirely:

- Tool schemas: `src/agent.ts:594-703` (`exec` :598, `web_search` :617, `schedule_task` :640,
  `save_workspace` :658, `plan` :667, `plan_done` :687).
- Dispatch switch that executes each call and decides what the model sees back:
  `src/agent.ts:754-876`; model-facing tool message push at :875 (full `out`), UI card clip at :872.
- Shared executors: `execSandbox()` `src/agent.ts:468-503` (stdout `clip(...,4000)` / stderr
  `clip(...,1500)` at :493), `webSearch()` `src/agent.ts:425-461`, `formatSearchResults()`
  `src/agent.ts:108-133` (excerpt `clip(...,400)` at :121), `clip()` itself `src/agent.ts:90-92`.
- Deterministic paths: `DIRECT_RUN_RE` `src/agent.ts:80` used at :541-548 ("run:"/"exec:"/"execute ",
  no LLM, bypasses `isRisky` gate by design — :538-540, `src/guardrails.ts:12-13`);
  `DIRECT_SEARCH_RE` `src/agent.ts:87` used at :552-567 ("search:").
- Context that shapes tool use: `CAPABILITIES` prompt `src/agent.ts:54-64`, tool round cap 4
  (`for round < 4` :715, fallback reply :900), guardrail hold `src/agent.ts:851-858`,
  backend endpoints `deploy/sandbox-worker/src/index.ts` (`/run` :118, `/workspace/snapshot` :99,
  unused `/session/kill` :83), memory/job RPCs only exposed to the UI (`jobList` `src/agent.ts:260`,
  `src/index.ts:79-95`), Telegram ingress `deploy/telegram-bridge/src/index.ts:23-59`.

Not in scope: prompt engineering of the persona/self-critique (other reports), router internals,
UI rendering except where it mirrors the tool contract (`ui/index.html:367-368` Tools tab).

## Tool inventory

| Tool | file:line | verdict |
|---|---|---|
| `exec` | `src/agent.ts:595-613`, exec path :848-865 + `execSandbox` :468-503 | Good description/return shape; **dispatch bug makes unknown tool names silently run `exec "true"`** (:848-849); truncation announced but not navigable (:91,:493); `&` background advice is wrong vs 5-min lease |
| `web_search` | `src/agent.ts:614-636`, dispatch :841-847, `webSearch` :425-461 | Best-designed tool here: capped, signalled, actionable tail (:125-131). Gaps: no way to read a found page (400-char excerpts :121); result cap is client-side only, body sends no limit (:444) |
| `schedule_task` | `src/agent.ts:637-654`, dispatch :801-821 | **Silently fires +1 min on bad/missing timing args** (:802-811); returns no job id (:816-818); no list/cancel companion; `daily_at` regex admits `24:99` (:805) |
| `save_workspace` | `src/agent.ts:655-663`, dispatch :822-840 | Works, but persistence depends on the model remembering to call it; restores only on fresh boot (`deploy/sandbox-worker/src/index.ts:51-63`, TTL 600s :13). Returns raw `JSON.stringify` blob (:838) |
| `plan` | `src/agent.ts:664-683`, dispatch :771-787 | Solid: error text teaches retry (:778), echo'd numbered plan is reasoning-ready (:783-785), 12-step cap (:775). Nit: no max length per step at schema level (`.slice(0,200)` in `src/memory.ts:222`) |
| `plan_done` | `src/agent.ts:684-702`, dispatch :788-800 | Name reads as "the plan is finished" → mis-select risk; **marks a nonexistent step "done" and reports success** (:795-799, `src/memory.ts:233-236`); `status` is free-text, only `blocked` recognized (:790) |
| direct run/exec/execute | `src/agent.ts:80`, :541-548 | Reliable and testable (`tests/live-matrix.mjs:47-55`) but regex fires on plain English ("run the tests" → shell `the tests`); hard-codes gate bypass with no channel allowlist (Telegram forwards any chat, `deploy/telegram-bridge/src/index.ts:23-27`) |
| direct search | `src/agent.ts:87`, :552-567 | Same separator flaw ("search how to X" silently rewrites the query to "how to X" — mild); output/`tools[]` contract is consistent with the model tool path |

## Problems & risks

- **[Critical] Unknown tool names degrade into a fake-success `exec`.** The dispatch `else` at
  `src/agent.ts:848-849` treats *any* name that isn't one of the five known tools as `exec` with
  `cmd = args.cmd || "true"`. A hallucinated `read_file`/`browser_navigate` call with a `path` arg
  runs `/usr/bin/true`, exits 0, and the model receives "exit 0 (success)" (:490-493) — it then
  believes the nonexistent tool worked. This is the worst possible failure mode for a
  function-calling surface: silent acceptance of invalid calls. Dispatch should return
  `Unknown tool "<name>". Available: exec, web_search, ...` and set `runOk=false`.
- **[Critical] `DIRECT_RUN_RE` matches ordinary sentences.** `/^(run|exec|execute)\s*[:\s]\s*(.+)$/is`
  (`src/agent.ts:80`) allows a bare space as separator, so "run the tests", "execute my plan",
  "exec my script" all execute the remainder as a shell command with **no model and no approval
  gate** (:541-548, gate bypass documented at :538-540 and `src/guardrails.ts:12-13`). Two fixes:
  require the colon, and/or only apply the shortcut on authenticated first-party channels. Today
  the Telegram bridge forwards *any* chat id to `handleChat` unfiltered
  (`deploy/telegram-bridge/src/index.ts:23-27`), so anyone who finds the bot can type
  `run: rm -rf ~` and skip `isRisky` (the pattern `\brm\s+-[a-z]*r` would otherwise hold it,
  `src/guardrails.ts:21`).
- **[Critical] `schedule_task` mis-schedules silently.** If `daily_at` fails the regex and
  `minutes_from_now` is absent/non-numeric, `dueAt` stays at `now + 60_000` and the job fires in
  one minute (`src/agent.ts:802-811`), while the confirmation (:816-818) still says "Scheduled".
  "Remind me every evening at 7" phrased as `daily_at: "19:00 UTC"` (regex-hostile) becomes a
  one-off firing now. Also: no job id in the response (nothing to cancel — and there is no cancel
  anyway), and `daily_at: "24:99"` passes the regex (:805) then rolls over via `setUTCHours`
  (`src/memory.ts:180-185`).
- **[Major] `plan_done` validates nothing.** `markPlanStep` UPDATEs 0 rows when there is no plan
  or `ord` is out of range, and the dispatch still returns ok with
  "Marked step N done. 0 step(s) still pending." (`src/agent.ts:795-799`; `src/memory.ts:233-236`).
  A model that forgot to call `plan` gets positive reinforcement for marking ghost steps.
- **[Major] File persistence depends on model discipline.** Snapshots are restored only when a
  *fresh* sandbox boots (`deploy/sandbox-worker/src/index.ts:51-63`); the warm pool entry expires
  after `POOL_TTL = 600` s (:13). If the model skips `save_workspace` (the only instruction is
  "Call after creating important files", `src/agent.ts:660`) the work dies with the lease. An
  auto-snapshot after any `exec` that plausibly wrote to `/workspace` (or a cheap end-of-turn
  snapshot) removes the footgun; keep the manual tool as well.
- **[Major] No workspace file read/write tool → everything squeezes through `exec`.** `cat` output
  is clipped at 4000 chars with only "[truncated N chars]" and **no continuation guidance**
  (`src/agent.ts:91`, :493) — the model sees a cut file and no offset to resume from, so it either
  re-runs blind or invents the missing tail. Writing files needs quoting/`echo|base64` gymnastics.
  This is the single biggest capability gap for "research + build + deliver" plans (:669).
- **[Major] No model-facing memory tool.** Recall/remember are infrastructure-only
  (`src/agent.ts:510-522`, `src/memory.ts:96-126`); the prompt even promises "recall happens
  automatically" (:55). The model can never say "remember this on purpose" (with kind/importance)
  nor search memory for a named fact mid-task, and `recall`'s `LIKE '%first-120-chars%'`
  (`src/agent.ts:512`) is weak on its own.
- **[Major] The model is blind to its own schedule.** Jobs are listable/cancelable only via the
  UI RPC `jobList` (`src/agent.ts:260-262`, `src/index.ts:79-86`); there is no delete/cancel path
  at all (no endpoint, no tool). "Cancel my 8am job", "what's running tomorrow?" are unanswerable,
  and a mis-created schedule (see Critical above) cannot be undone.
- **[Major] Search finds, but can't read.** Excerpts are clipped to 400 chars
  (`src/agent.ts:121`); to actually read a result the model must `exec curl`, paying raw HTML into
  the same 4000-char clip with no html→text. `web_search` and `exec curl` overlap badly; a
  dedicated `read_url` fixes it (Parallel exposes `/v1/extract`,
  <https://docs.parallel.ai/search/search-quickstart>).
- **[Major] Capability prompt / tools array / UI drift is manual.** `CAPABILITIES`
  (`src/agent.ts:54-64`) states it must be edited "together with" the tools array and the UI's
  Tools tab (`ui/index.html:367-368`), and the deterministic "what can you do" answer is a third
  hand-written copy (:578-587). Three sources of truth for one contract; a new tool must be added
  in 4 places (dispatch too) or the agent lies about itself.
- **[Minor] `exec`'s background-work advice is misleading.** Param text says "background
  long-running work (e.g. 'sleep 120 &')" (`src/agent.ts:607`) but the run request returns after
  `timeoutMs: 60_000` (`deploy/sandbox-worker/src/index.ts:118,135`) and orphan processes die with
  the 5-min lease (:12). Also a 60s timeout surfaces as `sandbox infrastructure error (502) run:
  ...` (:163-167 → `src/agent.ts:495-497`) with no "your command timed out, split it" hint.
- **[Minor] `plan_done.status` is free-text** with a silent default to `done`
  (`src/agent.ts:694-697`, :790); should be an enum `["done","blocked","skipped"]`.
- **[Minor] `save_workspace` success returns raw `JSON.stringify(sd)`** (`src/agent.ts:838`) —
  works, but a sentence ("saved 12,345 bytes at 12:03Z") is easier to reason over than a JSON blob.
- **[Minor] Bad tool-args JSON yields a raw exception.** `JSON.parse` failure becomes
  "tool error: SyntaxError..." (`src/agent.ts:759`, :866-868) with no schema reminder; every other
  error path in this file is better.
- **[Minor] `web_search` cap is client-side only.** The body sends `{objective, search_queries}`
  with no result limit (`src/agent.ts:444`); Parallel's own default is 10, the local slice caps at
  `max_results` (:116-117). Token-safe, mildly cost-wasteful.
- **[Minor] Round-limit fallback talks to the user, not the model.**
  "(hit the tool round limit; try a simpler ask)" (`src/agent.ts:715`, :900) — at 4 rounds with
  multiple calls per round it's generous, but when it does hit, the recovery hint is delivered as
  the final answer rather than as a tool result that could steer a retry.
- **[Good] Things done right** (keep these patterns): `formatSearchResults` tail *tells the model
  how to get more* ("Raise max_results (up to 10) or narrow the query", `src/agent.ts:130`);
  failed execs get "command FAILED with exit N; read stderr before retrying" (:492); the HELD
  message explains exactly what to say to the user and forbids workarounds (:857); plan echo with
  numbering (:783-785); empty-results search says "try a broader query" (:114).

## Per-tool notes

**`exec`** (`src/agent.ts:595-613`)
Description is a genuine mini-prompt: what it is ("one shell command in the agent's persistent
Linux sandbox"), when ("files, Python, downloads... anything that needs a real machine"), how
(cwd `/workspace`, `python3`, write-then-run files, "never report success for a command that
failed", :600). Example in the param: `'python3 solve.py' or 'ls -la /workspace'` (:607).
Return (`execSandbox` :468-503): exit-code header + stdout(4000)/stderr(1500) — reasoning-ready,
truncation **signalled but not navigable**. Merge/split call: do NOT split into
run_python/run_shell; instead add the `files` tool below so `exec` stays "run a command" and stops
being "also my file API". The `else`-as-exec dispatch (:848) is the one thing that must change.

**`web_search`** (`src/agent.ts:614-636`)
Clean what/when ("current information... Prefer this over guessing", :619), example query (:626),
`max_results` 1-10 default 5 (:630, enforced :436). Failure copy tells the model and user what to
do (missing key :431; empty query :434; HTTP fail incl. "key may lack the Search product" :451;
empty results :114). No mis-selection risk vs `read_url` once the latter exists (search = discover,
read = a URL I already have). Naming is the only nit: BLIP's direct prefix is `search:` while the
tool is `web_search` — fine, just keep both docs consistent (`src/agent.ts:58`, :576).

**`schedule_task`** (`src/agent.ts:637-654`)
What/when good ("reminded, done later, on a schedule... full tool access", :642). But: both timing
params are optional with no required-semantic ("exactly one of"), so the +1-min fallback (:803)
converts model confusion into a wrong real-world action; `title`/`instructions` descriptions are
stubs (:646-647 — no format/example, unlike the other tools); UTC-only `daily_at` is stated in the
param (:649) but the prompt never warns the model to convert the user's local time — expect
timezone bugs from users ("8am" → `daily_at "08:00"` = 8am UTC). Response should include the job id
and the next-fire human time; fix by validating that exactly one of `daily_at`/`minutes_from_now`
is present and returning a teaching error otherwise.

**`save_workspace`** (`src/agent.ts:655-663`)
No params — that's honest (it snapshots `/workspace` only). Mis-selection risk: model may expect
it to save outside `/workspace`; description could say "everything outside /workspace is
ephemeral". Return should be prose + bytes (:838). Bigger fix is automatic snapshots (Major above).

**`plan`** (`src/agent.ts:664-683`)
"When" is excellent ("Call this FIRST for any multi-step task", :669), param has a 3-step example
(:677), 12-step cap (:775). Overlap check: `plan` vs `schedule_task` are distinct (checklist vs
timer) — keep separate. Only real gap: the model can't *read* the current plan back
(no `plan(list)`) except via the echo in the set/done outputs — acceptable, since the tool result
(:799) already carries remaining counts.

**`plan_done`** (`src/agent.ts:684-702`)
Rename to `mark_step` (or add "Marks ONE step of the plan; the plan is not finished just because
you called this" to the description) — "plan_done" invites end-of-task mis-calls, which the
mandatory `ord` (:699) luckily prevents from being harmful, but see the [Major] ghost-step bug.

**Direct "run:"/"exec:"/"execute" path** (`src/agent.ts:80`, :541-548)
Purpose is sound: tool calling stays 100% testable with a free model that ignores prompts
(:74-80 comment; `tests/live-matrix.mjs:47-55`). Consequences to own: (1) colon-required or
channel-restricted (Critical); (2) the reply is raw sandbox output with the same 4000 clip (:547)
which is fine for a human who just typed the command; (3) it is absent from `CAPABILITIES` UI
Tools tab parity — documented at :56 and :573, OK.

## Recommended NEW tools

Selected for workflow shape (5 new tools, not one-per-endpoint). Not recommended: a *set model
tier* tool — tier is a channel-level argument (`onMessage` `src/agent.ts:338`, scheduled runs pin
"cheap" :354); letting the model escalate its own cost is a footgun, and `primary`/`cheap` are
currently the same model anyway (`src/types.ts` `DEFAULT_MODEL_*`). Not recommended: a separate *edit_file*:
`files.write` (full content) + `exec` covers it at this scale.

### 1. `files` — workspace file I/O (highest priority)
```jsonc
{
  "type": "function",
  "function": {
    "name": "files",
    "description": "Read, write, or list files in the sandbox /workspace (the persistent home). Use this instead of cat/echo/heredoc through exec: reads come back paged and continuation-explicit, writes need no shell quoting. action=read: returns the file from line offset, max max_bytes, with a 'call again with offset=N for the rest' footer when clipped. action=write: overwrites/creates path with content (auto-mkdir parents); re-read the path afterwards to confirm. action=list: directory listing, name+size, depth-limited. Files outside /workspace must go through exec.",
    "parameters": {
      "type": "object",
      "properties": {
        "action": { "type": "string", "enum": ["read", "write", "list"],
          "description": "Operation to perform." },
        "path": { "type": "string",
          "description": "Absolute path under /workspace, e.g. '/workspace/report.md' or '/workspace/data' for list." },
        "content": { "type": "string",
          "description": "action=write only: full new file contents (max ~40KB; for larger or binary use exec)." },
        "offset": { "type": "number",
          "description": "action=read only: starting line, 1-based. Example: 401 to continue after a clip at line 400. Default 1." },
        "max_bytes": { "type": "number",
          "description": "action=read only: cap on returned bytes, default 6000, max 20000." }
      },
      "required": ["action", "path"]
    }
  }
}
```
Return shape (text, model-reasoning-ready): header line `report.md lines 1-120 of 340 (6,012 bytes returned, file 18,240):` + content, and when clipped
`[continuing? call files(action:"read", path:"...", offset:121)]`. Writes return `wrote 1,234 bytes to /workspace/x.py (exit 0)` via the sandbox (`deploy/sandbox-worker` E2B `sbx.files` API, or `/run` with `printf '%s' b64 | base64 -d > path` under the hood — implementation detail, hidden from the model). This kills the echo|base64 hacks and the blind-cat problem (`src/agent.ts:493`).

### 2. `memory` — explicit remember/search/forget
```jsonc
{
  "name": "memory",
  "description": "Persist facts about the user and the project across sessions, beyond the automatic recall. action=remember: store a durable fact (kind: 'user' for preferences/identity, 'project' for ongoing work, 'reference' for links/IDs; importance 1-5, 5=never forget). action=search: keyword search of stored memories, returns id+content. action=forget: delete a memory id found via search. Use when the user says 'remember that...' or you learn something durable; don't store routine tool noise.",
  "parameters": {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["remember", "search", "forget"] },
      "content": { "type": "string", "description": "action=remember only: one self-contained fact, e.g. 'User prefers UTC in all schedules; timezone is GMT+8'." },
      "kind": { "type": "string", "enum": ["user", "project", "reference"], "description": "action=remember only. Default 'project'." },
      "importance": { "type": "number", "description": "1-5. Default 3." },
      "query": { "type": "string", "description": "action=search only: keywords, e.g. 'deploy router render'." },
      "id": { "type": "number", "description": "action=forget only: memory id from a search result." }
    },
    "required": ["action"]
  }
}
```
Backed by the existing `memories` table (`src/memory.ts:96-126`); needs a `deleteById` helper and
ids already exist. Search results must include ids (to enable `forget`) — the current
`MemoryRow` (`src/memory.ts:12-19`) carries them.

### 3. `read_url` — fetch-and-read a known URL (distinct from `web_search`)
```jsonc
{
  "name": "read_url",
  "description": "Fetch one specific URL and return its main text (HTML converted to readable text), so you can actually read a page web_search only showed you a 400-char excerpt of. Example flow: web_search finds the pricing page, read_url reads it. Returns up to max_chars with a 'continues at char N' footer when clipped; binary/PDF or non-text pages come back as a description, not garbage. Pages that need JavaScript may return little text — fall back to exec curl or a differently-worded search.",
  "parameters": {
    "type": "object",
    "properties": {
      "url": { "type": "string", "description": "Absolute http(s) URL, e.g. 'https://docs.parallel.ai/search/search-quickstart'." },
      "max_chars": { "type": "number", "description": "1000-12000, default 6000." },
      "start_char": { "type": "number", "description": "Offset for continuation, default 0." }
    },
    "required": ["url"]
  }
}
```
Implementation options: Parallel `/v1/extract` (same `PARALLEL_API_KEY` product family,
<https://docs.parallel.ai/search/search-quickstart>) preferred; fallback to `exec curl` + a
text-extraction step inside the worker (never reuse the raw 4000 exec clip). Note: a plain fetch
here is read-only and outward-safe, so no `isRisky` hold is needed, but add an SSRF-ish guard to
skip internal hostnames.

### 4. `jobs` — list/cancel the model's own schedule
```jsonc
{
  "name": "jobs",
  "description": "Inspect and manage scheduled background jobs created by schedule_task. action=list: every job with its id, title, status (pending/running), next fire time in ISO-UTC, and recurrence ('daily:HH:MM' or null=one-off). action=cancel: delete a job by id (the only way to undo a wrong schedule). Use list before answering 'what's scheduled' or 'cancel my reminder'; quote the id from list, never invent one.",
  "parameters": {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["list", "cancel"] },
      "id": { "type": "number", "description": "action=cancel only: job id from action=list." }
    },
    "required": ["action"]
  }
}
```
Backed by `listTasks` (`src/memory.ts:39-44`) + a `DELETE FROM tasks WHERE id=?`; depends on
`schedule_task` starting to return the inserted id (mirror `holdAction`'s
`last_insert_rowid()` pattern, `src/memory.ts:246`).

### 5. `reset_sandbox` — escape hatch for a wedged environment
```jsonc
{
  "name": "reset_sandbox",
  "description": "Kill the current sandbox VM and start clean on next exec. /workspace is snapshotted first (like save_workspace), so files survive; everything else — running processes, installs, /tmp, package state — is lost. Use when the sandbox is misbehaving (hung background process, broken install, out of disk) or when the user asks to reset their computer. Do not use casually.",
  "parameters": { "type": "object", "properties": {} }
}
```
Two existing endpoints compose it: `POST /workspace/snapshot` then `POST /session/kill`
(`deploy/sandbox-worker/src/index.ts:99-116, 83-97`; `/session/kill` currently has **no caller at
all** — the capability exists and is unreachable). Return prose: "sandbox reset; workspace saved
(12,345 bytes). Next exec boots a fresh VM." Effort is S/M because it is one dispatch arm calling
two RPCs.

Also (schema fix, not a new tool): `schedule_task` must return the job id — without it `jobs.cancel`
can't undo *this turn's* mistake.

## Next features

| Effort | Item |
|---|---|
| S | Reject unknown tool names in dispatch with a teaching error (`src/agent.ts:848`) + unit test |
| S | Require colon in `DIRECT_RUN_RE`/`DIRECT_SEARCH_RE` (`src/agent.ts:80,87`) |
| S | `schedule_task`: error (not silent +1min) when neither/invalid timing (`:802-811`); return job id; tighten `daily_at` to `^([01]\d|2[0-3]):[0-5]\d$` |
| S | `plan_done`: verify `ord` exists in plan, else return teaching error (`:795-799`); enum-ify `status`; rename to `mark_step` or amend description |
| S | `save_workspace` human-readable return (`:838`); auto-snapshot at end of any turn where an exec succeeded |
| S | `reset_sandbox` tool (composes two existing sandbox endpoints) |
| M | `files` tool (read/write/list) — new sandbox helper endpoint or b64-pipe wrapper |
| M | `jobs` list/cancel + `schedule_task` id return |
| M | `memory` tool (remember/search/forget) |
| M | `read_url` via Parallel /v1/extract |
| M | Generate `CAPABILITIES` + UI Tools tab + "what can you do" copy from the single tools array (`src/agent.ts:54-64,578-587`; `ui/index.html:367`) — one source of truth |
| L | Vector/embedding recall to replace `LIKE` (`src/memory.ts:94` TODO comment; needs router embeddings lane) |
| L | Outbound notification delivery when scheduled jobs finish (today results only land in chat history, `src/agent.ts:355-356`) — crosses into the Telegram/security domain |
| L | Telegram sender allowlist + approval buttons (touches the run: bypass end-to-end; coordinate with the security report) |

## Open questions for the user

1. Is the space-separated `run <cmd>` / `execute <cmd>` form (no colon) a feature you actually use?
   Requiring `run:` closes the "run the tests" misfire and the unauthenticated-Telegram-RCE hole.
2. Who may message the Telegram bot today — is bot privacy off / chat ids public? The `run:` gate
   bypass (`src/agent.ts:538-540`) is only safe if inbound is allowlisted.
3. Auto-snapshot after every exec vs keep manual `save_workspace` (cost: KV writes per turn; KV
   single-value limit ~25MB caps the workspace tar, `deploy/sandbox-worker/src/index.ts:114`)?
4. Does your Parallel key/plan include the Extract product (for `read_url`), or should `read_url`
   be a plain `fetch` + html→text in the worker instead?
5. `daily_at` is UTC-only — do you want user-timezone conversion stored in memory (a `tz` param /
   a remembered UTC offset), given "remind me at 8" is the flagship use case?
6. Should the model ever be able to hold/release its own approvals (no, per current design —
   confirm), and should `schedule_task` jobs get more/less than 4 tool rounds when they fire?

Sources consulted (public): Parallel API docs — [Search API Quickstart](https://docs.parallel.ai/search/search-quickstart);
[Parallel AI Search (LiteLLM)](https://docs.litellm.ai/docs/search/parallel_ai);
[OpenClaw parallel-search notes (Parallel API default result count = 10)](https://openclaw.zhcndoc.com/tools/parallel-search).
