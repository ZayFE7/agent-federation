# Autonomy core design

Date: 2026-10-26
Status: proposed, revised after builder check
Scope: the first of five projects that turn BLIP from a turn-based chat agent into a durable, supervised autonomous agent.

## Why

BLIP can already use tools, install skills, configure MCP servers, run scheduled jobs, spawn a researcher, persist files, and ask for approval. What it cannot do is hold a goal. Every capability lives inside one turn or one fixed schedule row. The agent stops when the model stops, loses the thread when a step fails, has no budget, and has no independent check that the goal was actually met.

The autonomy core adds the missing spine: a durable goal with a plan, bounded steps, checkpoints, retries, independent verification, budgets, audit, and user control. It does not add new tools to the world. It makes the existing tools usable over hours or days without a human driving every turn.

## Program sequence

1. Autonomy core: goals, steps, runs, verifier, budgets, audit, global pause, Goals UI. This document.
2. Notifications and attention inbox: reach the user when a goal is done, blocked, or needs approval.
3. Event triggers: wake goals on signed webhooks, watchers, and conditions, not only time.
4. Semantic memory: cross-session user and project memory, built as its own top-tier project.
5. Small quality batch: version restore, search, drafts, queue, goal templates, approval inbox polish.
6. Later, only if needed: durable compute and multi-agent supervision.

Each project gets its own design and plan. This document does not silently include the later ones.

## Goals

- A user or the agent can create a goal with a title, a brief, success criteria, and an optional budget.
- The goal survives Durable Object eviction, deploys, and long waits.
- A planner turns the brief into a small ordered plan of bounded steps.
- Each step runs as a normal BLIP turn in a dedicated goal session, with the same tools, files, skills, MCP servers, approvals, and artifacts.
- A goal created from a chat starts with a copy of that chat's current workspace, so the work continues from the files the user saw.
- The system checkpoints after every step and can resume from the last durable point.
- An independent verifier checks evidence against the step and goal criteria, not just the agent's claim.
- Failures retry with a limit, replan within a limit, or stop and ask the user.
- Retries never silently repeat an irreversible side effect.
- Every goal has token, active-time, tool-call, step, retry, and replan budgets.
- A global pause and a per-goal pause stop new work; cancel aborts a running step.
- Every transition, tool call, verdict, and budget change is auditable.
- The console shows active goals, the current step, progress, budget, and controls.
- The original chat stays a normal chat. It gets a creation card with a link, and the goal runs elsewhere.

## Non-goals

- Browser or coding runtimes.
- Inbound webhooks, email ingestion, page watchers, or conditional schedules. Event triggers are the next project.
- Push notifications or email delivery. The core writes attention rows; delivery is the next project.
- Semantic or vector memory. The core may read existing `memories` rows through the current recall path, but it does not build the new memory system.
- Multi-agent fleets, parallel step execution, or a supervisor hierarchy.
- Durable long-running processes. A step is one bounded turn; a VM may die between steps.
- A general workflow editor or visual plan builder.
- Auto-approving risky actions. Existing approvals stay authoritative.
- Exact dollar accounting. Tokens and tool calls are counted; spend is not promised.

## Anti-goals

- An unbounded loop that keeps calling the model until it feels done.
- A goal that can never be stopped or inspected.
- Declaring success from the agent's own summary with no evidence.
- Silent retries that repeat an external write, payment, or deletion.
- Two writers to a step. One lease, one run token, one completion.
- Hiding failures in logs the user cannot see.
- Letting a goal consume an unbounded context or an unbounded number of steps.
- Replacing chat. Goals are an additional mode; ordinary conversation stays turn-based.

## Constraints

- Cloudflare Workers, Durable Objects with SQLite, existing `agents` ThinkHarness, existing Durable Streams, existing E2B sandbox, existing auth.
- One writer per workstream. This project edits `repo-clone` first and mirrors to the deploy tree, never `wrangler.jsonc` by content comparison.
- Public repo: no keys, tunnel hosts, relay prefixes, or account ids in code, docs, tests, or logs.
- No new paid dependency and no card. Everything runs on the existing free-tier services.
- Existing approvals, guardrails, workspace persistence, and capability honesty must keep working.
- DO SQLite row limit is 2 MB. Goal and audit payloads must be capped and must point to files or artifacts instead of embedding large content.
- The planner and verifier must be injectable so offline tests never call a model.
- Each goal session is dedicated. It cannot be shared with another goal or an ordinary chat while a goal is active.
- New session-side tables are allowed for goal-run mapping and the tool ledger. This is a deliberate exception to keeping session DDL untouched.

## Architecture decision

Add a singleton `AutonomyAgent` Durable Object, bound as `AUTONOMY`. It is the coordinator and the only writer of goal state.

Why a new DO instead of extending `RegistryAgent`:

- Goals have their own tables, alarm cadence, retention, and failure modes.
- A goal supervisor restarting must not risk the session index.
- Registry remains a small index with a stable schema.
- A singleton coordinator gives one place for the global pause, concurrency cap, and attention queue.

Why steps run through a dedicated session DO instead of the coordinator running a model loop:

- The session already owns the workspace, files, artifacts, skills, MCP catalog, approvals, harness, and streams. Reusing it means goals get every existing capability without duplicating the agent loop.
- The user can open the goal session and see the actual step transcript and files.
- The coordinator stays small and testable; it never needs E2B or tool code.
- A dedicated session means one goal per harness, isolated abort, clean attribution, and no interleaving with ordinary chat.

The coordinator does call the model directly for two narrow jobs: planning and verification. Both are one-shot, tool-free, JSON-shaped calls. They are injected interfaces so tests can use fakes.

### Goal session and workspace copy

A goal always gets a new session titled `Goal: <title>`, marked as a goal session in the registry metadata or title prefix. The origin session is only a source of files and a link.

At creation from a chat:

1. Ensure the origin workspace is snapshotted to its KV tar.
2. Create the goal session through the existing session creation path.
3. Copy the origin workspace archive to the goal session's workspace key and seed the goal session's workspace pointer.
4. Store `origin_session_id`, `workspace_source`, and the copy result on the goal.

If the origin has no workspace, the goal starts empty and says so. If the copy fails, goal creation fails before planning, with a clear error; do not start a goal that silently lost the user's files. The copy is bounded by the existing workspace archive cap. An oversize workspace blocks creation with the existing cap message.

The goal session's composer stays enabled. While the goal is active, a message there is stored as a goal instruction and does not start a normal harness turn. The user can use the origin chat for ordinary conversation. When the goal reaches done, cancelled, or failed, the goal session becomes a normal chat.

## Data model

All tables live in `AutonomyAgent` unless marked as session-side. All ids are opaque strings; dates are epoch milliseconds.

`goals`:

- `id TEXT PRIMARY KEY`
- `session_id TEXT NOT NULL` (dedicated goal session)
- `origin_session_id TEXT` (the chat that created it, if any)
- `workspace_source TEXT` (`origin`, `empty`, or a copy error)
- `title TEXT NOT NULL`
- `brief TEXT NOT NULL` (the user's intent, verbatim where possible)
- `success_criteria TEXT NOT NULL` (observable outcomes, not a vibe)
- `status TEXT NOT NULL` (`planning`, `active`, `waiting`, `verifying`, `blocked`, `done`, `cancelled`, `failed`)
- `paused INTEGER NOT NULL DEFAULT 0`
- `plan_version INTEGER NOT NULL DEFAULT 0`
- `budget_json TEXT NOT NULL`
- `usage_json TEXT NOT NULL`
- `current_step_id TEXT`
- `summary TEXT`
- `last_error TEXT`
- `created_at`, `updated_at`, `started_at`, `finished_at`

`goal_steps`:

- `id TEXT PRIMARY KEY`
- `goal_id TEXT NOT NULL`
- `plan_version INTEGER NOT NULL`
- `seq INTEGER NOT NULL`
- `kind TEXT NOT NULL` (`work` or `wait`)
- `title TEXT NOT NULL`
- `objective TEXT NOT NULL`
- `done_when TEXT NOT NULL` (human-readable success, paired with `checks_json`)
- `checks_json TEXT` (structured checks, capped)
- `status TEXT NOT NULL` (`queued`, `running`, `verifying`, `done`, `failed`, `blocked`, `skipped`, `superseded`)
- `attempts INTEGER NOT NULL DEFAULT 0`
- `max_attempts INTEGER NOT NULL`
- `wake_at INTEGER` (for wait steps)
- `lease_token TEXT`
- `lease_until INTEGER`
- `evidence_json TEXT` (capped; file paths, hashes, exit codes, artifact ids)
- `result_json TEXT` (capped)
- `last_error TEXT`
- `created_at`, `updated_at`, `started_at`, `finished_at`

`goal_plans`:

- `id TEXT PRIMARY KEY`
- `goal_id`, `version`
- `plan_json TEXT` (capped)
- `reason TEXT` (initial, retry, replan)
- `created_at`

`goal_runs`:

- `id TEXT PRIMARY KEY`
- `goal_id`, `step_id`, `session_id`
- `status` (`running`, `done`, `failed`, `aborted`, `stale`)
- `usage_json` (tokens, model steps, tool calls, active ms, model id)
- `result_json` (capped)
- `error`
- `started_at`, `finished_at`

`goal_events`:

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `goal_id`, `step_id?`, `run_id?`
- `type` (created, planned, step_queued, step_started, step_accepted, tool_called, step_finished, evidence_collected, verified, retry, replanned, paused, resumed, budget_warning, budget_exhausted, approval_requested, approved, denied, completed, failed, cancelled, instruction_added, superseded, session_deleted)
- `actor` (`system`, `agent`, `user`, `verifier`)
- `payload_json` capped at 16 KB
- `created_at`

`goal_tool_calls`:

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `goal_id`, `step_id`, `run_id`
- `tool TEXT`
- `input_hash TEXT`
- `side_effect INTEGER`
- `result_json` capped
- `created_at`

This is the coordinator's compact copy of the session ledger. The session's write-ahead ledger is authoritative.

`goal_instructions`:

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `goal_id`
- `content TEXT` capped at 8 KB
- `created_at`

`goal_attention`:

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `goal_id`
- `kind` (`done`, `failed`, `blocked`, `budget_exhausted`, `approval`)
- `title`, `body`
- `read INTEGER DEFAULT 0`
- `created_at`

`goal_meta`:

- `key TEXT PRIMARY KEY`, `value TEXT`
- holds the global pause flag, schema version, and coordinator counters.

Indexes: `goals(status, updated_at)`, `goals(session_id)`, a partial unique index on `goals(session_id)` where status is not terminal, `goal_steps(goal_id, plan_version, seq)`, `goal_runs(goal_id, started_at)`, `goal_events(goal_id, id)`, `goal_attention(read, created_at)`.

Payload caps: goal brief 16 KB, success criteria 8 KB, step objective 8 KB, checks 16 KB, evidence 32 KB, event payload 16 KB, audit retention 30 days or 5,000 events per goal, whichever first.

### Session-side tables

`goal_run_ops` maps every harness operation in a goal run, including continuations and approval continuations:

- `run_id TEXT`, `operation_id TEXT PRIMARY KEY`
- `root INTEGER NOT NULL` (the first operation of the turn)
- `status` (`running`, `done`, `failed`, `aborted`, `pending_approval`)
- `usage_json`
- `created_at`, `updated_at`

`goal_run_tools` is the write-ahead ledger:

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `run_id`, `step_id`, `goal_id`
- `tool TEXT`, `input_hash TEXT`
- `side_effect INTEGER NOT NULL`
- `status` (`intent`, `finished`, `failed`)
- `result_json` capped
- `created_at`, `updated_at`

The session writes `intent` before executing a tool and `finished` or `failed` after. A crash between intent and finish is detectable and forbids an automatic retry. This ledger lives in the session because the session sees the tool result and may not be able to reach the coordinator mid-call.

## Goal lifecycle

1. Creation validates title, brief, and success criteria, creates the dedicated session, copies the workspace, inserts the goal in `planning`, and returns immediately.
2. `planning`: the alarm triggers one planner call with 1 to 12 steps. Each step has a title, objective, observable `done_when`, structured checks, suggested tools, a risk flag, and `max_attempts`. Invalid output gets one repair attempt, then a single-step fallback plan and a visible note.
3. `active`: the first eligible step is claimed. Work steps start a run; wait steps set `wake_at` and move the goal to `waiting`.
4. `waiting`: the next step is a wait or future `wake_at`. The alarm is armed for that time. No model spend while waiting.
5. `verifying`: a step finished; deterministic checks and the verifier run. Verdicts are `pass`, `retry`, `replan`, `blocked`, or `done` at goal level.
6. `blocked`: needs the user, a missing credential, an unavailable tool, or a budget. An attention row is written. The goal does not auto-resume.
7. `done`: all plan steps are done and the goal-level success criteria are verified. A deterministic summary is stored and an attention row is written.
8. `cancelled`: aborts a running goal run if present; no further steps.
9. `failed`: terminal only when the plan cannot be repaired within limits and the user has not chosen to retry.

Pause is a flag, not a status. A paused goal remains in its current status but the supervisor starts nothing. Global pause sets `goal_meta.paused=1` and the alarm checks it first.

## Step execution protocol

1. Coordinator marks the step `running`, increments attempts, writes `started_at`, creates a run with a random `run_id` and `lease_token`, and sets `lease_until = now + 15 minutes`. The lease covers queue time only until the session accepts the run.
2. Coordinator calls the linked session DO's `startGoalStep` RPC with:
   - goal id, step id, run id, lease token
   - the step prompt
   - remaining budgets
   - the check list
3. The session may accept immediately or queue the run behind its own current work. On acceptance it calls `goalRunAccepted(runId, token)`; the coordinator sets `started_at`, extends the lease, and starts the active-time clock. Queue time does not count against the step.
4. The session starts a normal harness turn with tools. The turn gets the step prompt. It never gets the planner or verifier conversation.
5. The session records the root operation and every continuation or approval operation in `goal_run_ops`. It writes tool intents and results to `goal_run_tools`. It reports approval parks to the coordinator.
6. The session does not decide whether the goal is done. It collects evidence and reports completion when the operation chain is final: no running continuation, no pending approval.
7. When the chain is final, the session calls `completeGoalStep({ runId, leaseToken, status, result, evidence, usage })`. The coordinator accepts only a matching run and token; duplicates are ignored and audited.
8. The coordinator stores evidence and usage, then runs verification.
9. A pass advances to the next step. A retry requeues the same step with verifier feedback. A replan goes back to planning with the remaining work. A block writes attention. Done completes the goal.

If the session call fails before acceptance, the coordinator retries with backoff. If it was accepted but no completion arrives before the lease, the coordinator marks the run `stale`. A stale run with no recorded tool intent is retried. A stale run with any tool intent is blocked for review. This is the rule that prevents silent double payments, messages, or deletions.

If an approval is parked, the session sets the run's operation state to `pending_approval`, calls `goalApprovalPending(runId)`, and pauses the active-time clock and lease. The coordinator releases the global running slot and marks the goal blocked with an approval attention row. The run is not killed. When the user decides, the session resumes, writes a new operation linked to the same run, and eventually reports completion.

Cancel calls `abortGoalRun(runId)`; the session aborts only operations linked to that run. Because the session is dedicated, this cannot kill an unrelated chat. A cancelled run's ledger is preserved for audit.

### What the step prompt contains

- The user's goal brief and success criteria, verbatim.
- The current step objective, `done_when`, and structured checks.
- A short digest of completed steps: title, result, evidence pointers.
- Any user instructions added after the goal started.
- The remaining budget for this step.
- A fixed rule: use tools, do not claim success without evidence, stop and report if blocked, do not repeat side effects from a prior attempt.
- A required final report shape: what was done, evidence, open issues, and the next recommended step.

It does not contain: the planner's hidden reasoning, the verifier prompt, unrelated chat sessions, memory beyond the current recall path, or secrets.

## Planner

One tool-free model call. Input: title, brief, success criteria, constraints, budget, current date/time, and a short workspace summary. Output JSON:

```json
{
  "steps": [
    {
      "kind": "work",
      "title": "short imperative",
      "objective": "what this step must accomplish",
      "done_when": "observable success",
      "checks": [
        { "type": "file", "path": "out/result.md", "min_bytes": 1 },
        { "type": "artifact", "path": "out/result.md" },
        { "type": "tool_exit", "tool": "exec", "code": 0 },
        { "type": "text", "criterion": "The report names the three sources it used." }
      ],
      "suggested_tools": ["exec", "write_file"],
      "risky": false,
      "max_attempts": 2
    },
    {
      "kind": "wait",
      "title": "wait for the scheduled window",
      "objective": "resume after the wait",
      "done_when": "the wake time has passed",
      "checks": [],
      "wake_at": 1793000000000,
      "max_attempts": 1
    }
  ]
}
```

Rules: 1 to 12 steps, each work step independently runnable in one turn, no step that says "continue until done", no hidden dependency on unavailable credentials, observable `done_when`, checks that the session can evaluate. The planner can use `wait_minutes` instead of `wake_at`. Invalid JSON gets one repair call, then a one-step fallback.

A replan creates a new `goal_plans` version. Unfinished steps from the old version become `superseded`, not deleted. Completed steps stay. `max_steps` counts work steps that are not `superseded` or `skipped`. Plan history is shown in the UI and audit.

Planner calls are audited as `planned`, with the raw output capped. The user can see the plan; plan editing is not in this phase. The user can add an instruction, pause, cancel, or ask for a retry through controls.

## Verifier

Two layers, deterministic first.

The session collects evidence through trusted code, not the model's report, using `collectGoalEvidence(runId, checks)`:

- file existence, size, and sha256 via direct sandbox reads
- artifact presence via the session artifact store
- tool exit codes and results from `goal_run_tools`
- whether a declared forbidden effect appears in the ledger

The coordinator stores that evidence. It never needs E2B access.

Deterministic checks, evaluated from the evidence:

- required exit codes
- required files exist and, when declared, expected hashes or sizes
- required artifacts are attached
- required commands or tests passed
- no declared forbidden effect occurred

If a deterministic check fails, the verdict is `retry` or `blocked` without a model call. This removes self-grading for the strongest checks.

Model verifier, used for judgment criteria:

- tool-free call with goal brief, success criteria, step objective, `done_when`, the step's final report, capped evidence, and the deterministic results.
- returns JSON with `verdict`, `reason`, `feedback`, `evidence_used`, and `goal_done`.
- must cite the evidence it used. Evidence it cannot see cannot justify a pass.
- invalid JSON or an ambiguous answer fails closed to `blocked`, never to `pass`.

The verifier never executes tools and never sees the planner's hidden reasoning. After the last work step passes, a goal-level verification runs. `done` requires every non-superseded work step to be done and the goal success criteria to be satisfied. If the last step passes but `goal_done` is false, the goal replans once if budget allows, otherwise blocks. A step-level `pass` is never treated as goal completion.

A user can override a block with an explicit resume/retry, and that override is audited.

## Budgets and limits

Defaults per goal, editable at creation and later through the goal route:

- `max_steps`: 30 work steps
- `max_tool_calls`: 150
- `max_active_ms`: 6 hours of active execution, excluding waits and approval time
- `max_tokens`: 2,000,000, best effort
- `max_attempts_per_step`: 2
- `max_replans`: 2
- `max_wait_ms`: 7 days per wait, 30 days per goal of waiting

Per-step hard limits across the whole run chain, not per operation: one harness turn chain, 12 model steps total, 20 tool calls, 10 minutes active. Exceeding a per-step limit aborts the entire run chain and lets the verifier or coordinator decide.

Usage is recorded from the session completion: model steps, tool calls, tokens when the provider reports them, and active milliseconds. The provider's finish chunk usage is captured in the existing event mirror and summed across operations. If usage is missing, it is stored as null, not guessed. Planner and verifier usage are counted too. `max_tokens` is best effort; steps, tool calls, and active time are the hard limits that cannot be bypassed.

Warnings fire at 70% and 90%. At 100% the coordinator aborts any running run, marks the goal blocked with `budget_exhausted`, writes attention, and does not start another step. A user can increase the budget and resume; the increase is audited. Goal-step turns cannot change their own budget.

Global limits: at most 2 runs active across all goals, and at most 10 goals active. A third eligible step waits in the queue. These are conservative defaults for the free tier and can be raised by config.

Global pause: sets `goal_meta.paused=1`, aborts running sessions, and re-queues steps that have no side-effecting tool recorded. Steps with side effects become blocked for review. Resume restores the flag and arms the alarm.

## Side-effect policy and retry safety

The session writes `intent` before every tool call and `finished` after. The ledger is the basis for retry decisions.

Side-effecting by default:

- `exec`, unless the command matches a strict read-only allowlist. The allowlist is intentionally small: `ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find` without `-exec`/`-delete`, `stat`, `file`, `du`, `df`, `uname`, `whoami`, `date`, `git status`, `git diff`, `git log`, `git show`. A shell pipeline inherits the most side-effecting segment. Tests and builds are side-effecting because they can write files.
- `write_file`, unless an identical path and content hash already has a finished record. A write is otherwise treated as a world change and not auto-retried.
- `mcp_call`, unless the MCP server/tool is explicitly configured read-only. Default is side-effecting.
- `delegate`, because the child can run `exec`.
- `skill_install` and `schedule_task`.
- Any future tool without an explicit `readOnly` annotation.

Read-only: `lookup_online`, `skill` (read/use), and the goal-status tools. Goal tools are not available to goal-step turns at all.

A stale run with an `intent` and no `finished` record is blocked, regardless of the tool. A stale run with only finished read-only calls is retried. A stale run with a finished side-effecting call is blocked. A verifier retry of a step whose ledger has any side-effecting call is blocked, not retried. The user can review evidence and retry manually; that manual retry is audited and starts a new attempt with a warning.

## Audit

Every transition and every side-effecting tool call is an event. The audit timeline is readable in the goal detail. Logs never contain full prompts, full tool inputs, or secrets; they contain summaries, hashes, and pointers.

Retention: 30 days or 5,000 events per goal, whichever first, pruned by the alarm. The goal row keeps a compact summary after pruning.

Tracing: every goal run gets the goal id and run id in the existing trace span, so a trace can be joined to the audit.

## UI

Navigation: rename the current Tasks item to **Goals** and keep the existing scheduled jobs as a **Scheduled** section inside it. This avoids a seventh sidebar item on mobile.

Goals list:

- sections: Active, Needs you, Waiting, Done
- each row: title, status chip, current step `n of m`, progress bar, budget meter, last update, origin chat, goal session
- New goal button with a small form: title, brief, success criteria, budget preset
- Global pause control in the header or the list header

Goal detail:

- header: title, status, pause/resume, cancel, retry, link to origin chat and goal session
- current step, current run, and plan version
- plan timeline with step states, superseded versions, and attempts
- evidence and verifier verdict per step
- budget bars and usage
- audit timeline
- "Add instruction" input, which is injected into the next step and audited
- mobile: full-width, using the chat center; no right inspector

Activity panel:

- when a goal is running, show the title, current step, elapsed active time, and a link
- if blocked or done, show a Needs you row with an action

Chat:

- the origin chat shows a compact creation card with the goal title, plan size, and link; it stays a normal chat
- the goal session shows the step transcripts, files, and a deterministic completion message built from the verifier reason and the last step report excerpt; no third model call
- when the goal session becomes terminal, its composer returns to normal chat behavior

In-app attention rows are written by the core. Delivery, unread badges outside the Goals page, push, and email are the next project.

## Routes and tools

Routes, all behind the existing bearer gate:

- `GET /api/goals?status=&limit=`
- `POST /api/goals` with title, brief, success criteria, origin session id, budget overrides. Creates the dedicated goal session, copies files, returns the goal and goal session immediately; planning runs asynchronously.
- `GET /api/goals/:id`
- `GET /api/goals/:id/events?after=`
- `POST /api/goals/:id/control` with `pause`, `resume`, `cancel`, `retry`, `instruct`, `budget`
- `GET /api/goals/attention`

Session delete guard: `DELETE /api/sessions/:id` asks `AUTONOMY` whether a non-terminal goal owns the session. If yes, it returns 409 with the goal id and does not delete. Origin sessions have no such lock because their files were copied.

Tools (three, not ten), available only to the normal chat agent and never to a goal-step turn:

- `goal_create({ title, brief, success_criteria, budget? })` uses the current chat's workspace as the copy source, creates the goal session, and returns the goal id. Budget is clamped to server maxima.
- `goal_status({ id? })` returns one goal or the list.
- `goal_control({ id, action, note? })` with actions pause, resume, cancel, instruct. Budget and retry are route-only, because they can restart effects or spend more.

`EXPECTED_TOOLS` grows from eight to eleven. The capability table gets a "Durable goals" row. The system prompt gets one short rule: goals are for multi-step outcomes that should survive the turn; ordinary chat stays a normal turn.

## Security and safety

- Existing approvals remain the gate for risky effects. Goals do not get a bypass.
- The coordinator cannot execute tools; only the linked session can.
- Goal-step turns do not receive `goal_create`, `goal_status`, or `goal_control`. A step cannot raise its own budget, clear its block, or create more goals.
- The planner and verifier have no tools and no access to credentials.
- A side-effecting tool recorded in the ledger changes retry behavior. This is a safety rule, not an optimization.
- Goal briefs and evidence are untrusted text. The planner and verifier must treat them as data, not instructions. Prompt injection in a file or web result cannot change the goal's budget or approval policy.
- No goal can raise its own budget or clear its own block. Only an authenticated route, or a chat tool action explicitly limited to pause/resume/cancel/instruct, can.
- Cancel is always available and always wins over a queued step.
- Global pause is checked before every claim, not just when the alarm fires.
- Logs and audit exclude secrets; the model provider keys stay in the worker environment.

## Failure handling

- Planner invalid: one repair, then fallback, audit both.
- Verifier invalid: fail closed to blocked.
- Session unreachable: backoff and retry; after three failures the step becomes blocked with a clear error.
- Run lease expires: stale run rules above.
- Duplicate completion: ignored, audited.
- Duplicate alarm: idempotent claim by step id.
- DO eviction: all state in SQLite; `onStart` re-arms the alarm and resumes from the first eligible step.
- User cancels while a step is running: session aborts the run chain, step cancelled, no retry.
- Budget exhausted mid-step: abort, block, attention.
- Approval parked: run stays alive, active clock and lease pause, goal shows blocked, decision resumes it.
- Goal session deleted despite the guard: next step fails closed and blocks with `session_deleted`.
- Origin chat deleted: no effect; the goal owns its copied workspace.

## Testing

Offline, deterministic, no model or network:

- pure state-machine tests for every transition, retry, replan, budget, pause, cancel, stale lease, wait, and duplicate completion
- store tests with the existing fake SQL handle for schema, caps, and retention
- planner/verifier adapter tests with fake responses, including invalid JSON and fail-closed
- route tests with a fake AutonomyAgent stub
- tool tests for the three tools and the capability row
- workspace copy tests with a fake workspace store, including empty, oversize, and failure
- run-chain tests with fake operations, continuations, and approval continuation
- ledger tests: intent before call, finish after, stale intent, read-only allowlist, side-effect retry block
- evidence tests for file hashes, artifacts, exit codes, and missing usage
- session-delete guard tests
- UI text and structure checks; `node --check` for the console script
- cross-tree identity checks

Live, opt-in:

- a goal that writes a file, verifies its existence and hash, and completes
- a goal created from a chat with an existing file, proving the workspace copy
- a goal whose step fails once and retries successfully
- a goal with a budget of one step that blocks visibly
- a pause/cancel while a step runs
- an approval-parked step that resumes after a decision
- a reload of the Goals page while a goal runs
- deleting the origin chat does not affect the goal; deleting the goal session while active is refused

Every offline test is silent on success, matching the current suite. The full suite must stay green in both trees, and the live script must be documented in `tests/README.md`.

## Deployment

- New Durable Object binding `AUTONOMY` and class export.
- Idempotent schema in the new DO.
- New session-side tables for `goal_run_ops` and `goal_run_tools`, created idempotently.
- Deploy both trees, then run the live goal script and the existing matrix.
- No push unless the user asks.

## Decisions made in this design

- A singleton coordinator DO, not the registry.
- Every goal gets a dedicated goal session and a copied workspace. The origin chat stays normal.
- One goal per goal session; the partial unique index enforces it.
- Steps execute through the goal session DO, not a second agent loop.
- A run spans the root operation, auto-continuations, and approval continuations; completion waits for the final chain.
- The session owns the write-ahead tool ledger; the coordinator keeps a compact audit copy.
- Side effects are classified conservatively; an intent without a finish forbids automatic retry.
- Planner and verifier are tool-free and injected for tests.
- Structured checks plus session-collected evidence, not model claims.
- Goal tools are excluded from goal-step turns; budget and retry are route-only.
- Token usage is captured when available and best effort; steps, tool calls, and active time are hard.
- Waiting and approval time do not consume active time or a global running slot.
- Replans are versioned; old unfinished steps are superseded, never deleted.
- Goal sessions are protected from deletion while non-terminal; origin sessions are not.
- In-app attention rows are in scope; external delivery is not.
- Event triggers, semantic memory, durable compute, and multi-agent work are explicitly deferred.

## Left to the builder

- Exact file split and names, SQL statements, RPC signatures, prompt text, and test fixtures.
- The UI layout within the existing design system, using the current tokens and components.
- The exact default budget constants after a cost check against the current provider.
- How the workspace archive copy is executed in the sandbox worker and how the goal session's workspace pointer is seeded.
- How the run-chain completion is detected from the harness's existing continuation and approval paths.
- How much plan detail is shown to the user without overwhelming the mobile layout.
