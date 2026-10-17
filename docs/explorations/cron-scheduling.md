# BLIP — Cron jobs + scheduling reliability

Analyst domain: how background jobs get scheduled, woken, run, re-armed and reported.
Read-only exploration; no source file was modified. Repo is public — env-var **names** only, never values.

## Scope

In scope (all paths repo-relative):

- `src/agent.ts:342-410` — `onScheduledTask()` (the alarm tick) and `armTick()` (the re-arm).
- `src/agent.ts:212-215` — `onStart()` (cold-start arming).
- `src/agent.ts:637-654`, `src/agent.ts:801-821` — the `schedule_task` tool definition and its
  `when`/`recurrence` parsing.
- `src/memory.ts:39-85`, `src/memory.ts:152-185` — `tasks` schema + legacy prune, `enqueueTask`,
  `dueTasks`, `nextDailyDue`.
- `src/index.ts:296-308` + `wrangler.jsonc:29-33` — the Worker-level cron (`*/10 * * * *`) and its
  handler.
- `src/agent.ts:505-534`, `src/agent.ts:353-356` — how a fired job's output is stored and how it (not)
  reaches the user; `ui/index.html:359-364`, `ui/index.html:386` — the Tasks board and "While you were away".
- Public platform contracts: Cloudflare Durable Object Alarms, Workers Cron Triggers, Agents SDK
  `schedule()` / retries / queues (URLs in `## Sources`).

Out of scope (covered by sibling reports): tool-surface wording and parameter ergonomics
(`docs/explorations/tools.md`), sandbox lifetime (`docs/explorations/e2b-sandbox.md`), the router
lane that a fired job calls into (`docs/explorations/*router*` when written), auth/guardrail
treatment of job-emitted commands (`docs/explorations/security-guardrails.md`).

---

## Current behavior (file:line)

### The job board

`tasks(id, title, status, due_at, payload, created_at, recurrence)` — `src/memory.ts:63-71`, plus an
idempotent `ALTER TABLE tasks ADD COLUMN recurrence TEXT` guarded by a catch-all so old databases
upgrade in place (`src/memory.ts:72-79`). `ensureSchema` then deletes every row with
`status='done' AND recurrence IS NULL` — the legacy "served one-off" backlog — once per isolate
(`src/memory.ts:80-84`, exercised by `tests/memory.test.mjs:64-87`).

Statuses actually used: `'pending'` (insert, `src/memory.ts:160`), `'running'`
(`src/agent.ts:348-351`), back to `'pending'` with a new `due_at` for daily rows
(`src/agent.ts:369-372`), and **`DELETE`** for everything else (`src/agent.ts:381`). Nothing in the
current code ever writes `'done'`.

### Creating a job (`schedule_task`)

`src/agent.ts:801-821`:

- `daily_at` matching `/^\d{1,2}:\d{2}$/` → `dueAt = nextDailyDue(h, m, now)` and
  `recurrence = "daily:HH:MM"` (`:805-808`).
- else `minutes_from_now` as a number → `dueAt = now + max(1, n) * 60_000` (`:809-810`).
- else → `dueAt = now + 60_000`, one-off, no recurrence (`:803`) — a silent default, not an error.
- `instructions` (≤2000 chars) go into `tasks.payload`; `title` is only a label (`:812-814`).
- Confirmation text always says UTC: `Scheduled "X" daily at 08:00 UTC. Next run <ISO>` (`:816-818`).

Crucially, this path **only inserts a row**. It never calls `armTick()`/`schedule()`, so creating a
job does not change when the DO next wakes.

### The wake model

There is exactly one wake source for jobs: a **Durable Object alarm** that BLIP re-creates at the end
of each tick.

- `armTick()` (`src/agent.ts:388-410`) reads `SELECT MIN(due_at) FROM tasks WHERE status='pending'`
  and computes `delayMs = min(60_000, max(5_000, soonest - now))`, defaulting to `60_000` when
  nothing is pending ("Default to the 1-minute safety poll so the tick chain never dies", `:398`),
  then `await this.schedule(delayMs, "onScheduledTask")` (`:406`).
- `onStart()` also arms once per new isolate (`src/agent.ts:212-215`).
- `onScheduledTask()` (`src/agent.ts:343-386`): `dueTasks(sql, Date.now())` → for each row: write a
  `task` memory, flip to `running`, run `handleChat(payload || title, "cheap")`, write a `task-done`
  memory plus an assistant message `[scheduled] <reply>`, then re-arm daily rows in place or delete
  the row; finally `await this.armTick()`.

The Worker cron `*/10 * * * *` (`wrangler.jsonc:31-33`) is **not** part of the job path at all: its
handler only fetches `RENDER_URL/health` and returns early when `RENDER_URL` is unset
(`src/index.ts:297-307`). It never touches `env.FEDERATION_AGENT`. So the brief's assumption "jobs
run when the */10 cron fires" is wrong — if the alarm chain dies, nothing else wakes the DO except
inbound traffic (HTTP/WS/RPC), which then calls `onStart` → `armTick`.

Intended precision: sub-minute for jobs due within the [5 s, 60 s] window, and a 60 s polling floor
for anything further out. Actual precision is bounded by the units question below.

### Recurrence grammar

One dialect only: `daily:HH:MM` (`src/agent.ts:365` compile-side, `:808` write-side; the tick's
regex `/^daily:(\d{1,2}):(\d{1,2})$/` matches anything the writer can produce, so a job either
re-arms forever or is deleted). Anything else in `recurrence` — `weekly:*`, `interval:*`, a cron
expression — falls into the `else` branch at `src/agent.ts:380-383` and the row is **deleted on its
first fire**.

### Timezone

`nextDailyDue` builds the timestamp with `setUTCHours(hh, mm, 0, 0)` and `setUTCDate(+1)`
(`src/memory.ts:180-185`) — pure UTC arithmetic on the epoch. Same function is used by the tool
(`src/agent.ts:807`) and by the re-arm (`src/agent.ts:368`). No user timezone exists anywhere in the
data model: not in `tasks`, not in `memories` (the only mention is a *test fixture*,
`tests/memory.test.mjs:91`), not in `Env` (`src/types.ts:51-77`), not in `wrangler.jsonc:37-40`.

### Where results go

- `memories` rows of kind `task` / `task-done` / `error` (`src/agent.ts:347`, `:355`, `:359`, `:377`, `:382`).
- `messages` row `[scheduled] <reply>` with role `assistant` (`src/agent.ts:356`).
- Nowhere else: no result column on `tasks`, no run-history table, no push to any client.

The only consumer of the `[scheduled]` message is the next chat turn's context window —
`recentMessages(sql, 6)` filtered to user/assistant (`src/agent.ts:525-527`) — i.e. the model may
mention it. The user sees nothing deterministic.

### User-visible board

`GET /api/tasks` → `jobList()` → `listTasks(sql, 20)` = 20 newest rows by `created_at DESC`
(`src/index.ts:79-86`, `src/agent.ts:260-262`, `src/memory.ts:39-44`). The UI splits those rows into
`live = status!=="done"` and `done = status==="done"`, renders the away timeline **only from `done`**
and the header "All jobs finished" only when `done` is non-empty (`ui/index.html:359-364`, `:386`).

---

## Problems & risks

### [Critical] C1 — `schedule()` takes seconds; the code passes milliseconds → every job is 1.4–16.7 h late

`src/agent.ts:398-406` computes a value in **ms** (`delayMs`, clamped to `[5_000, 60_000]`) and hands
it to `this.schedule(delayMs, "onScheduledTask")`. The Agents SDK's contract is
`schedule(when, callback, payload?, options?)` where `when` is "number (**seconds**), Date, or cron
string" — the docs' own examples are `this.schedule(30, "sendReminder", …)` and
`this.schedule(60, "checkStatus", …)`. Under that contract:

| intent | code value | SDK reading | real latency |
|---|---|---|---|
| "1-minute safety poll" | `60_000` | 60 000 s | **16 h 40 min** |
| job due in 30 s | `30_000` | 30 000 s | **8 h 20 min** |
| job due in 2 s (floor) | `5_000` | 5 000 s | **1 h 23 min** |

So the floor is ~83 minutes late and the idle loop sleeps ~16.7 h; "every morning at 8" runs
somewhere between 09:23 and the following day, and a "remind me in 5 minutes" is useless. The
inline comments (`src/agent.ts:397` "1-minute safety poll") and `README.md:7` ("jobs fire from a
self-rearming 1 minute alarm") show the author's mental model is ms — this is a units bug, not a
design choice. The lockfile resolves `agents@0.28.1` (`package.json:9` declares `"latest"`), so the
deployed semantics can change under us without a commit.

Verification before fixing (5 min, no code change needed to test): ask BLIP for a one-off 2 minutes
out, log `Date.now()` at arm and at fire in `onScheduledTask`, and diff; also inspect the SDK's
`cf_agents_schedules` table (`SELECT * FROM cf_agents_schedules`) in a `wrangler dev` session.
Fix is a one-liner (`Math.round(delayMs/1000)`), but see C2 — it is not sufficient.

### [Critical] C2 — Scheduling a job never shortens the pending alarm

`schedule_task` inserts a row and returns (`src/agent.ts:814`); nothing calls `armTick()` on that
path. The next wake is whenever the *previously* armed alarm lands. Consequences:

- Idle DO with the 60 000-second poll armed: a job requested for "+2 minutes" waits up to ~16.7 h.
- Even after C1 is fixed, a job due in 3 s that lands while a 60 s poll is pending inherits the 60 s.
- The platform allows only **one** alarm per DO ("Each Durable Object is able to schedule a single
  alarm at a time", DO Alarms docs), so arming is a global, replaceable slot — the code must replace
  it deliberately at insert time, not accidentally at tick time.

Fix: make `armTick()` (or a new `armForNextDue()`) a first-class invariant — call it after every
`enqueueTask`, after every delete/cancel, and from `onStart`. It must be idempotent and monotone
("never arm later than the earliest pending due").

### [Critical] C3 — Daily jobs are UTC-anchored; the user is in Morocco (UTC+1, UTC+0 during Ramadan)

`nextDailyDue` uses `setUTCHours` (`src/memory.ts:180-185`), so `daily_at:"08:00"` fires at 09:00
Casablanca time, year-round except during Ramadan when Morocco drops back to UTC+0 (then 08:00 is
correct again — a fixed `+1` offset is *also* wrong). The model is the only place that could convert,
and the prompt never tells it to: the system prompt says "every morning at 8" with no timezone note
(`src/agent.ts:57`, `:584`), the param description says "HH:MM 24h UTC" (`:649`), and the
confirmation echoes "…daily at 08:00 UTC" (`:817`) which the user reads as "8am". Meanwhile the Tasks
board renders `due_at` with `new Date(…).toLocaleString()` in the **browser's** timezone
(`ui/index.html:360`), so the board says 09:00 for a job the user called "8 o'clock". `tools.md:150-152`
reached the same conclusion from the tool-design angle. This is the flagship use case, so treat it as
a user-facing bug, not a nicety.

### [Critical] C4 — A malformed `daily_at` silently becomes a one-off that fires in ~1 minute and then self-destructs

`src/agent.ts:803-811`: the `daily_at` branch requires `/^\d{1,2}:\d{2}$/`. `"8:5"`, `"08.00"`,
`"8:00 AM"`, `"08:00:00"`, `"demain 8"` all fail the regex, `minutes_from_now` is usually absent, and
control reaches the default `dueAt = now + 60_000` with `recurrence = null`. The job then fires ~1
minute later, runs the full instructions against the live sandbox, and is **deleted** at
`src/agent.ts:381`. Net user experience of "every morning at 8 check X": it did something random one
minute after the conversation, and the board is now empty. There is no validation feedback — the tool
answers `ok:true` with a plausible-looking ISO timestamp (`:815-819`).

Same class: over-range values pass the loose regex — `daily_at:"99:99"` → `nextDailyDue(99, 99, now)`
→ `setUTCHours(99, 99)` normalises to **+4 days, 00:39** while storing `recurrence="daily:99:99"`,
which the re-arm regex happily matches (`:365`, `:368`). A recurring job can therefore be silently
shifted by days and keep re-arming forever.

### [Critical] C5 — Job output is now unreachable by the user: the board, the away timeline and every API dropped it

The recent retire-on-fire change (`src/agent.ts:361-383`, commit `3cc75b9`) removed every row that
produced a `'done'` status, but the UI's "While you were away" and the "All jobs finished" copy are
fed **exclusively** by `status==="done"` (`ui/index.html:359`, `:361`, `:364`, `:386`). Nothing sets
`'done'` anymore, so:

- the away timeline is permanently empty (and the inspector's `LG` list, `ui/index.html:355`);
- right after a job completes, the Tasks tab reads **"Nothing scheduled yet"**;
- `GET /api/tasks` cannot return the result even in principle, because the row is gone and the
  result only lives in `memories` (`task-done`, 800-char clipped, `src/agent.ts:355`) and `messages`
  (`[scheduled] …`, `:356`) — and **no route exposes either table** (`src/index.ts:59-113` covers
  message/tasks/plan/approve/decide/vault only).

The audit trail the change intended ("audit kept in task memory", `src/agent.ts:362-363`) exists only
as recall fodder for the model. The chat `LOG` array is per-page-load and never fetches history
(`ui/index.html:385`, `:397`). So a job that fires while the browser is closed is invisible until the
user happens to ask something that makes the model pull the memory. That is a regression in the
product's core promise ("Blip does things while you are away").

### [Critical] C6 — No claim/lock on a task: the same job can run twice

`src/agent.ts:346-351` reads `dueTasks()` (a plain SELECT, `src/memory.ts:169-174`) and then issues
`UPDATE tasks SET status='running' WHERE id=? AND status='pending'` **without checking whether the
update claimed anything** (no `rowsWritten` test). Two overlapping `onScheduledTask` invocations both
see the same `pending` row and both proceed to run it. Overlap is not exotic here:

- Alarms are documented as **at-least-once**: "Alarms have guaranteed at-least-once execution and are
  retried automatically when the `alarm()` handler throws… exponential backoff starting at a 2 second
  delay from the first failure with up to 6 retries allowed" (DO Alarms docs).
- The Agents SDK force-resets schedules it considers hung: "Hung schedule timeout is 30 seconds; it is
  force-reset" (Agent class internals). Our handler routinely exceeds 30 s — one `handleChat` is up to
  4 rounds × 25 s router timeout (`src/agent.ts:715-728`) plus a 20 s self-critique (`:998`) plus
  tool time. So the SDK can consider the run hung and re-deliver it while our loop is still executing
  the job.

A fired job has full `exec` + sandbox access (`src/agent.ts:353-354`), so a duplicate run is a
duplicate *real-world* side effect (post, send, spend). The safety gate only intercepts commands the
`isRisky` classifier recognises (`:851`), and the deterministic `run:` bypass (`:541-548`) is not in
this path but the model's own `exec` is.

Fix: turn the claim into a compare-and-set that is honoured
(`UPDATE … WHERE id=? AND status='pending'` → require 1 row written, else skip), and never let two
ticks interleave over the same due set.

### [Critical] C7 — A killed or throwing tick leaves a `'running'` zombie that no code path can ever revive

If execution stops between `src/agent.ts:349` (status→`running`) and `:369-383` (re-arm or delete) —
SQL error, DO eviction, alarm wall-clock expiry — the row stays `running` forever. `dueTasks` only
selects `status='pending'` (`src/memory.ts:171`) and `armTick`'s `MIN(due_at)` only looks at
`status='pending'` (`src/agent.ts:394`). So the job disappears from every query while still occupying
the board (the UI's `live` filter admits `running`, `ui/index.html:359` — "Running now" with a
hard-coded 60 % progress bar, `:360`), and its daily schedule is dead. Nothing reaps it. There is no
`started_at`/`heartbeat` column to make such a row detectable.

The 15-minute alarm wall clock is a plausible trigger: `onScheduledTask` runs **all** due tasks
serially in one invocation (`src/agent.ts:346-384`), each up to minutes, with no cap on the batch.
Combined with C1's ~16 h lag, the overdue set is exactly the "everything accumulated" set — a burst
that can be killed mid-loop. And because `armTick()` is the *last* statement (`:385`), a wall-clock
kill or a throw anywhere in the loop also means **no re-arm**.

### [Critical] C8 — No watchdog: the tick chain has no self-healing, and the one cron in the system ignores the DO

Recovery relies entirely on (a) the platform's ≤6 alarm retries with 2 s-based backoff, then (b) an
inbound request causing `onStart` → `armTick` (`src/agent.ts:212-215`). After 6 failed retries the
alarm is gone; jobs stop forever until someone messages Blip. Meanwhile `wrangler.jsonc:31-33` fires
`*/10 * * * *` and `src/index.ts:297-307` uses it purely as a Render keep-alive ping — and returns
immediately when `RENDER_URL` is unset (`:298`), i.e. in the current dev/default configuration the
cron is a complete no-op. A one-line change (call a DO RPC from `scheduled()`, *before* the
`RENDER_URL` guard) converts a free 10-minute heartbeat into exactly the watchdog C7/C8 need. Note
cron timing is coarse — the Workers Cron Triggers page quotes "may take several minutes (up to 15
minutes)" for aspects of invocation/metrics handling, and "Local development does not run Cron
Triggers automatically" (`curl "http://localhost:8787/cdn-cgi/local/scheduled"` is the local hook) —
so cron is a *safety net*, never the primary clock.

### [Major] M1 — Recurrence grammar is one line deep: `daily:HH:MM`, nothing else, and unrecognised strings mean "delete"

`src/agent.ts:365` only understands `daily:`; `:805-808` only writes `daily:`. No weekly, no
nth-weekday, no monthly, no interval ("every 4 h"), no cron expression, no expiry ("for 5 days"), no
timezone, no `n`-times. Because the branch is `if (daily) re-arm else delete`, any future value
written into `recurrence` by another code path silently converts a recurring job into a one-off that
vanishes on first fire (`:380-383`) — a landmine, not just a limitation. A stored-string grammar should
fail loud (unknown recurrence → park the row + `error` memory, never delete).

### [Major] M2 — No structured job payload / result / run history; the text column is doing four jobs

`tasks.payload` is the *only* instruction carrier (`src/memory.ts:66-70`, `src/agent.ts:353`), the
result is a clipped string in `memories` (`:355`), the next-fire time is recomputed by regex each tick
(`:364-368`), and there is no `last_run_at`, `next_run_at`, `run_count`, `last_error`,
`started_at`, `tz`, `delivery` or `archived_at`. `listTasks` returns 20 rows ordered by
`created_at DESC` (`src/memory.ts:41`), so an old daily job with high `id` newer rows silently
disappears from the board while remaining armed — the board is not a queue view, it is a "20 most
recent inserts" view. `GET /api/tasks` inherits that blind spot (`src/index.ts:84-85`).

### [Major] M3 — No per-job timeout, no batch cap, no concurrency control, no jitter

One tick = unbounded serial `handleChat` calls (`src/agent.ts:346`). A single job gets up to 4 tool
rounds (`:715`) × 25 s router timeout (`:727`) + 20 s search (`:446`) + 20 s self-critique (`:998`) —
so worst case a few minutes per job; five overdue jobs in one tick approach the 15-minute alarm
window (DO limits page: "Wall time: Alarm handlers limited to 15 minutes per invocation"), which is
how C7 and C6 bite. A job that must hold a human-approval gate (`:851-858`) will spin a full turn and
produce an `approve` reply into a `task-done` memory nobody reads. Also: because the idle loop is one
shared alarm, all daily jobs land on the same tick and hammer the router/sandbox together (the
thundering-herd problem is intra-DO here, but it still burns rate-limited provider quota at once).

### [Major] M4 — No catch-up policy: overdue jobs are all-or-nothing, and a late daily job can fire twice in one calendar day

`dueTasks` matches `due_at <= now` with no staleness bound (`src/memory.ts:171`), so a 16-hour
latency dump runs the whole backlog immediately, including reminders that are now nonsense ("remind
me to call the bank at 9" delivered at 02:00). Re-arm measures from *completion*: `nextDailyDue(h, m,
Date.now())` (`src/agent.ts:368`) — if a `daily:08:00` job finally runs at 01:00 the next day it
re-arms for 08:00 the *same* day, so it fires twice within ~30 hours; if it runs at 08:30 it skips
nothing. Correct behaviour needs slot-based arithmetic (`next slot strictly greater than the slot
just served`) plus an explicit misfire policy (`run-late-once` / `skip-to-next` / `ask`).

### [Major] M5 — Two schedulers, one truth: BLIP hand-rolls a poll loop on top of an SDK that already owns the alarm

`armTick` invents its own 5 s–60 s heartbeat and stores its own due times, while the SDK keeps a
`cf_agents_schedules` table, multiplexes multiple schedules onto the single DO alarm, deletes
one-time schedules after execution, reschedules cron ones automatically, and retries failures with
`{maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 3000}` and built-in jitter (Agent class internals;
Retries docs; v0.8.0 changelog: "Cron schedules are idempotent by default"). `docs/explorations/tools.md`
notes `schedule_task` never re-arms (C2). Consequences of the duplication: the 60 s poll keeps a
SQLite DO instantiated 1 440 times a day forever, even when the next job is 8 hours away — pure free
tier quota burn (see Open questions) — while the SDK's `Date`/cron paths could sleep exactly until
the due instant with zero polling. Also, each `armTick()` call registers a *new* SDK schedule row, so
any future migration to SDK scheduling must not leave the hand-rolled loop running or jobs double-fire.

### [Major] M6 — No way to see, pause, edit or cancel a job

There is no `list_tasks`/`cancel_task` tool (`src/agent.ts:594-703` has none) and no HTTP delete for
tasks (`src/index.ts` exposes only approve/vault mutations). Once a `daily:08:00` is written it
re-arms forever (`src/agent.ts:369-373`); the user's only recourse is chatting with a model that has
no tool to remove it. `jobList()` is the sole read path (`src/agent.ts:260-262`). This is the
"append-only scheduler" gap; it makes every other bug here permanently sticky.

### [Major] M7 — Scheduling correctness depends on an unpinned `"latest"` dependency and on stale documentation

`package.json:9` is `"agents": "latest"` (resolved `0.28.1` in `package-lock.json:2391-2395`), and the
scheduling contract (delay units, hung-schedule reset, retry defaults, cron idempotency) lives
entirely in that dependency. A redeploy can silently change job semantics. `README.md:7` documents
"jobs fire from a self-rearming 1 minute alarm" and `README.md:12` cites
`src/index.ts:253-263` for the cron handler (actual: `296-308`) — the doc will mislead the next
debugging session about exactly the thing that is broken.

### [Major] M8 — The tick path is untested

`tests/README.md:72-75` states plainly: "Nothing tests … the cron handler, or the DO memory, task,
plan, and pending-action schemas." `tests/memory.test.mjs:119-123` only *simulates* the retire branch
with a hand-written `DELETE`, so C5's contract is asserted against a copy of the logic, not the logic;
C1 (units), C2 (no re-arm on enqueue), C3 (timezone), C4 (`99:99`) and C7 (zombie reaping) are all
invisible to the suite. `armTick`/`onScheduledTask` are methods on the DO class and cannot currently
be imported without the SDK — a testability problem, not just a coverage gap.

### [Minor] m1 — `minutes_from_now` is unvalidated and unbounded

`src/agent.ts:809-810`: `Math.max(1, args.minutes_from_now)` accepts `NaN` (→ `due_at = NaN`, which
`dueTasks`' `due_at <= ?` never matches and `MIN(due_at)` ignores → the row sits pending forever,
invisible), accepts `1e12` (job armed ~19 000 years out, still occupying `jobList`'s 20-row window),
and accepts a numeric string (falls through to the +60 s default, same class as C4). No cap on the
horizon, no floor on staleness.

### [Minor] m2 — `onScheduledTask` ignores the alarm payload; `scheduled()` ignores its event

`src/agent.ts:343` takes `_payload?: unknown` and `src/index.ts:297` takes `_event`. The SDK hands a
payload to the handler and Workers hand `controller.scheduledTime`; ignoring both forfeits per-job
identity (batch-then-recompute is what forces C4/M4/C7 designs) and any ability to detect a skipped
tick.

### [Minor] m3 — `ensureSchema` is a schema check, a migration and a data purge in one catch-all-protected call

`src/memory.ts:75-84`: the `try { ALTER } catch {}` swallows *every* error, not just
duplicate-column, so a genuine storage failure is invisible; the `DELETE … status='done'` full-table
scan runs on every new isolate; and the purge is a one-time migration masquerading as an idempotent
schema step with no marker of having run. Once the board gains `archived_at` (M2) this statement
becomes actively destructive.

### [Minor] m4 — UI honesty nits on the tasks surface

`ui/index.html:360` renders a fake 60 % progress bar for any `running` row (and, per C7, for zombies
forever); `:386` computes the header "running" count as `status!=="done"`, i.e. it counts *pending
future* jobs as running; `awayState()` (`:356`) guesses a mascot state from the job title regex, so a
one-line job named "check the mail server" reads as email activity.

### [Minor] m5 — Reminder text has no delivery semantics

`payload` is always fed to `handleChat` as an instruction (`src/agent.ts:353`), so "remind me to buy
milk" becomes a *task* the model attempts (search/exec/plan) rather than a message to deliver.
There is no `deliver verbatim` flag and no message-body column, which is the missing primitive behind
the "reminders that deliver a message" feature request.

---

## Near-term improvements

Ordered by blast radius per line changed. Items 1-6 are the "make the current design honest" set.

1. **Fix the units and make arming an invariant** (C1, C2). `armTick` →
   `await this.schedule(Math.max(5, Math.round(delayMs / 1000)), "onScheduledTask")`; add
   `await this.armTick()` at the end of the `schedule_task` branch (`src/agent.ts:814`) and after any
   delete/cancel. Prefer passing a `Date` (`this.schedule(new Date(soonest), …)`) over a delay so the
   value is self-describing and cannot be mis-scaled.
2. **Stop deleting evidence; archive instead** (C5). Replace `DELETE FROM tasks WHERE id=?`
   (`src/agent.ts:381`) with `UPDATE … SET status='served', archived_at=?`, and add `archived_at` +
   `result` columns; keep the board filter (`ui/index.html:359`) showing only unarchived rows and the
   away timeline (`:361`, `:386`) showing `status='served'` rows with their `result`. This restores
   the "While you were away" feature with no UI rewrite and makes `ensureSchema`'s purge
   (`src/memory.ts:84`) safe to narrow to a one-shot migration.
3. **Honour the claim, and reap zombies** (C6, C7). Assert `rowsWritten === 1` after
   `UPDATE … WHERE status='pending'` and `continue` otherwise; add `started_at` to the claim UPDATE
   and, at the head of every tick, reset any `running` row whose `started_at` is older than a
   threshold (e.g. 20 min) back to `pending` with an `error` memory. This makes the tick
   self-healing against eviction and against the SDK's 30 s hung-reset re-delivery.
4. **Bound the batch and the job** (M3, C7). Cap tasks per tick (e.g. 3, oldest first), add a
   wall-clock budget check inside the loop so `armTick()` (`src/agent.ts:385`) always runs, and give a
   background turn a smaller round budget than an interactive one (the `for (round < 4)` loop at
   `:715`) plus a per-job `AbortSignal.timeout`.
5. **Validate `schedule_task` input and fail loudly** (C4, m1). Require exactly one of
   `daily_at`/`minutes_from_now`; reject `h > 23 || m > 59` and non-integer/NaN; return a teaching
   error string instead of the `now + 60_000` default; never accept a recurrence string the tick
   cannot parse (unknown → park the row + `error` memory, do not delete).
6. **Give the Worker cron a second job** (C8). In `src/index.ts:297`, *before* the `RENDER_URL`
   guard, call a cheap DO RPC (`agentStub(env).wake()` → `ensureSchema + armTick + reap zombies +
   dueTasks(now)`), so `*/10 * * * *` becomes the watchdog that makes alarms-at-least-once and
   chain death survivable. Keep the DO alarm as the precision clock; the cron only bounds the worst
   case to ~10-15 min.
7. **Per-user timezone, stored once** (C3). Add a `tz` setting (a `settings`/`memories` row or an
   optional `TZ` var name — value `Africa/Casablanca`) and compute `nextDailyDue(h, m, fromMs, tz)`
   with `Intl`, leaving storage in UTC. Suggested tz-safe helper (no dependency):
   format the candidate instant in `tz` and adjust —
   ```
   const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric",
     month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
     second: "2-digit", hour12: false });
   // build "YYYY-MM-DDTHH:MM:00Z" in the target zone, then Date.parse + offset-correct loop
   ```
   plus `nextUtcInstantForLocalWallClock(h, m, tz, fromMs)` that iterates day-by-day. Do **not**
   hard-code `+01:00`: Morocco returns to UTC+0 for Ramadan, so only an IANA zone is correct.
   Fix the copy too: confirm with "08:00 Casablanca (07:00 UTC)" and make the UI show both
   (`ui/index.html:360`, `src/agent.ts:817`).
8. **Replace the 60 s poll with SDK-native scheduling** (M5): one `schedule(new Date(due), …)` per
   one-off, one `schedule("MM HH * * *", …)` per daily job (SDK reschedules cron rows automatically
   and deletes one-time rows after execution), with `tasks` as the user-visible board. Get jitter and
   retries (`{maxAttempts, baseDelayMs, maxDelayMs}` are built in) for free instead of hand-rolling
   them. Cron strings are UTC-evaluated by Cloudflare, so keep converting the user's wall clock to
   UTC at *parse* time (item 7).
9. **Make it testable** (M8): extract the tick body into a pure `runDueTasks(sql, now, {run, arm})`
   in `src/memory.ts` (or a new `src/scheduler.ts`) so `tests/` can drive it with a fake `run`,
   asserting: late-day re-arm, `99:99` rejection, claim-exists-rows-checked, zombie reset, and that
   `arm` receives **seconds**.

---

## Next features

| # | Feature | What | Why | Design sketch | Effort | Risk |
|---|---|---|---|---|---|---|
| F1 | Real cron expressions | `cron:"0 8 * * *"` accepted by `schedule_task`, evaluated by the SDK | the grammar ceiling (M1) blocks "weekdays", "first of month", "every 6 h"; the SDK already parses cron and makes cron schedules idempotent | store `recurrence` as a tagged string (`cron:` / `daily:` / `weekly:` / `interval:` / `once:`); `schedule(when:"0 8 * * *", "onJob", {taskId})`; keep UTC and convert at parse (item 7); display the human next-fire in the reply | M | medium — units/UTC semantics must match the hand-rolled path during migration; two schedulers must not both be live (M5) |
| F2 | Weekly / monthly / interval | `weekly:MON,FRI:08:00`, `monthly:1:09:00`, `interval:4h` | the everyday personal-agent calendar is weekly, not daily | add `nextDue(recurrence, fromMs, tz)` dispatch replacing the single `daily:` regex at `src/agent.ts:365`; `interval:` recomputes from the *served slot*, not completion (M4); unknown tags park the row | M | medium — month-end and DST/Ramadan wall-clock edge cases need a real tz helper |
| F3 | Per-user timezone | IANA `tz` on the job and in settings; all arithmetic tz-aware | C3; the user is in Africa/Casablanca (UTC+1, UTC+0 in Ramadan) | settings row + `tz` param defaulting to it; `nextDailyDue(h,m,from,tz)`; UI shows zone label; confirmation echoes both clocks | S-M | low-medium — must not double-convert; test the Ramadan switch explicitly |
| F4 | Reminders that deliver a message body | `deliver:"verbatim"` + `message` field → the text lands in the chat/push, model work optional | today every reminder is re-interpreted as a task (m5) and its output is unreadable (C5) | new column `delivery_mode` (`task`\|`message`); for `message`, enqueue an outbound note and (a) insert an assistant `messages` row, (b) broadcast to open WS connections via the SDK's `sendToClient`, (c) POST to the Telegram bridge's send path (`deploy/telegram-bridge/src/index.ts:73`) when configured | M | medium — push needs a channel allowlist; a background job that talks to the user unsolicited is a trust surface |
| F5 | Job run history | `job_runs(job_id, started_at, finished_at, ok, output, error, alarm_source)` + `GET /api/jobs/:id/runs` + a UI timeline | "what did Blip do while I was away" needs an audit, not a memory row; also fixes C5/C7 diagnosis | write the row in the tick (`src/agent.ts:353-360`) instead of only `remember()`; cap/rotate (e.g. 50 runs/job); the away timeline reads `job_runs` joined to `tasks` (today it reads `status==='done'`, `ui/index.html:361`) | M | low — mostly additive schema; watch `messages`/`memories` growth |
| F6 | Catch-up-on-wake policy | explicit misfire rule per job: `skip` / `run-late-once` / `ask`, with a grace window | M4: today everything overdue dumps at once and a late daily job can double-fire | `dueTasks(now, graceMs)` gains a bound; on wake, `run_due > 1` → summarise into one "you missed N runs" message; re-arm from the served slot | S-M | medium — silently skipping is user-visible; default should be `run-late-once` within 2 h |
| F7 | Watchdog + self-heal | Worker `*/10` cron → DO RPC `wake()`; zombie `running` reaper; `armTick` on every mutation | C2/C7/C8: the chain currently dies silently | new public RPC on the agent + add to `AgentStub` (`src/index.ts:7-20`); call before the `RENDER_URL` guard (`:298`); reaper per near-term item 3 | S | low — idempotent by construction if the claim check (C6) lands first |
| F8 | Jitter + rate limiting | deterministic per-job offset (±0-90 s) and a max N jobs per tick, cheap-tier-only lanes | all 08:00 jobs land on one tick and hammer router + sandbox (M3); SDK retries already ship jitter | `dueAt += hash(jobId) % 90_000` at re-arm; batch cap in the tick loop; a "too many jobs" guard at enqueue | S-M | low — jitter must not push a job past its slot boundary |
| F9 | Job management surface | tools `list_jobs` / `cancel_task` / `update_task` + `DELETE /api/tasks/:id` + board row buttons | M6: the scheduler is append-only and mistakes are permanent | `status` values `pending/paused/served/failed`; `cancel_task(id)` deletes the SDK schedule row and archives; expose `next_run_at` computed at write time so the board stops depending on `created_at DESC LIMIT 20` (`src/memory.ts:41`) | M | low-medium — a model-callable delete needs the same care as `holdAction` (confirm-by-id) |
| F10 | Persisted derived columns | `next_run_at`, `last_run_at`, `run_count`, `last_error` on `tasks` | makes `armTick` a single indexed `MIN(next_run_at)` (M5), the board correct, and C7 diagnosable | write on every insert/re-arm; backfill in `ensureSchema` behind a version marker (not the current catch-all `ALTER`, `src/memory.ts:75`) | S | low |

Cheap wins first: units (item 1), archive-instead-of-delete (2), claim check + reaper (3), cron
watchdog (6), validation (5). Those five remove every [Critical] except timezone (C3) and the
recurrence ceiling, without new features.

---

## Open questions for the user

1. **Observed lateness.** Have you actually seen jobs arrive ~1-17 h late (C1) or roughly on time?
   A job created for "+2 minutes" firing much later is the smoking gun; the 5-minute test in C1
   settles it. If jobs *are* landing near-exact, the deployed SDK interprets the number as ms and the
   fix is "pin + write it explicitly as a `Date`" rather than a unit change.
2. **Timezone of record.** Confirm `Africa/Casablanca` as the default zone (not `Europe/Paris`), and
   whether you want the Ramadan UTC+0 drift handled automatically (only an IANA zone does that) — F3.
3. **Should a fired one-off stay visible forever, or roll off after N days?** Current intent was
   "disappear"; my recommendation is archive + surface in the away timeline (item 2 / F5). Which do
   you actually want on the Tasks board?
4. **Missed-run behaviour preference.** If Blip wakes 4 hours late: run it anyway, skip, or ask?
   Default policy for F6, per job class (reminders vs dailies probably differ).
5. **Push delivery.** Should job output be delivered unprompted — to the open console WebSocket and/or
   to Telegram (the bridge is pull-only today, `deploy/telegram-bridge/src/index.ts:73` only replies
   to inbound messages)? If yes, is one chat id allowlisted, given the bot's inbound surface is
   currently unauthenticated per `docs/explorations/security-guardrails.md`?
6. **Wake budget.** Is a DO waking every 60 s acceptable on your Cloudflare free tier (request and
   DO GB-s allowances), or should the scheduler sleep exactly until the next due instant (item 8)?
   This decides whether we keep any polling loop at all.
7. **How much autonomy does a background turn get?** It currently reuses the interactive loop (4 tool
   rounds, `src/agent.ts:715`) and can hit the approval gate with nobody watching (`:851-858`). Should
   jobs get fewer rounds / no risky commands / auto-deny instead of hold?
8. **Dependency pinning.** OK to pin `agents` to an exact version (`package.json:9` is `"latest"`) so
   the scheduling contract cannot shift under a redeploy (M7)?
9. **Recurrence vocabulary you actually need.** Weekdays-only? "last day of the month"? "every 90
   minutes while awake"? This bounds F1/F2 instead of us guessing.
10. **Legacy data.** Anything worth preserving from rows the `ensureSchema` purge already deleted
    (`src/memory.ts:84`) — or is the `memories` audit sufficient?

## Sources consulted (public docs)

- Cloudflare — Durable Object Alarms: [developers.cloudflare.com/durable-objects/api/alarms/](https://developers.cloudflare.com/durable-objects/api/alarms/)
  ("Each Durable Object is able to schedule a single alarm at a time", "Alarms have guaranteed
  at-least-once execution and are retried automatically when the `alarm()` handler throws", "Retries
  are performed using exponential backoff starting at a 2 second delay from the first failure with up
  to 6 retries allowed", "If the Durable Object wakes up after being inactive, the constructor is
  invoked before the alarm handler", "If an unexpected error terminates the Durable Object, the
  `alarm()` handler may be re-instantiated on another machine").
- Cloudflare — Durable Object limits: [developers.cloudflare.com/durable-objects/platform/limits/](https://developers.cloudflare.com/durable-objects/platform/limits/)
  (CPU 30 s default; "Wall time: Alarm handlers limited to 15 minutes per invocation").
- Cloudflare — Workers Cron Triggers: [developers.cloudflare.com/workers/configuration/cron-triggers/](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
  ("Cron Triggers execute on UTC time", "Local development does not run Cron Triggers
  automatically", `/cdn-cgi/local/scheduled`, "may take several minutes (up to 15 minutes)",
  `controller.scheduledTime`).
- Cloudflare Agents — Schedule tasks: [developers.cloudflare.com/agents/runtime/execution/schedule-tasks/](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/)
  (`schedule(when, callback, payload?, options?)`; `when` = number of **seconds**, `Date`, or cron
  string; schedules persist to SQLite; examples `this.schedule(30, "sendReminder", {…})`,
  `this.schedule("0 8 * * *", "dailyDigest", {…})`).
- Cloudflare Agents — Agent class internals: [developers.cloudflare.com/agents/runtime/lifecycle/agent-class/](https://developers.cloudflare.com/agents/runtime/lifecycle/agent-class/)
  (`cf_agents_schedules` table, one DO alarm multiplexing many schedules, "Hung schedule timeout is 30
  seconds; it is force-reset", "Cron schedules reschedule; one-time tasks delete", default retries
  `{maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 3000}`).
- Cloudflare Agents — Retries: [developers.cloudflare.com/agents/runtime/execution/retries/](https://developers.cloudflare.com/agents/runtime/execution/retries/)
  (retry options and "built-in" jitter for scheduled/queued tasks).
- Cloudflare Agents — Queue tasks: [developers.cloudflare.com/agents/runtime/execution/queue-tasks/](https://developers.cloudflare.com/agents/runtime/execution/queue-tasks/)
  ("Tasks are stored in a SQLite table… survive agent restarts"; queue is FIFO-now vs schedule-at-time).
- Cloudflare changelog — Agents SDK v0.8.0: [developers.cloudflare.com/changelog/post/2026-03-23-agents-sdk-v0.8.0/](https://developers.cloudflare.com/changelog/post/2026-03-23-agents-sdk-v0.8.0/)
  ("Cron schedules are idempotent by default", "Delayed and date-scheduled types support opt-in
  idempotency").
- Long-running agents pattern: [developers.cloudflare.com/agents/concepts/agentic-patterns/long-running-agents/](https://developers.cloudflare.com/agents/concepts/agentic-patterns/long-running-agents/)
  (`keepAlive()` for multi-minute work; workflows/fibers for longer).

Repo evidence also cited by siblings: `docs/explorations/tools.md:146-152`, `:327` (same UTC and
validation conclusions from the tool-design angle); `tests/README.md:71-74` (the cron handler is
untested).
