# Event triggers design

Date: 2026-10-26
Status: approved direction, implementation starting
Scope: Phase 3 of the autonomy roadmap. This is a standalone project that lands before the autonomy goal runtime and does not depend on it.

## End target

BLIP should react to the world without a user message. A user can define an automation once, and it fires from a webhook, a watched URL, or a schedule. Each fire creates a durable event, runs a turn in a chosen chat, records the run, and shows what happened in the console. Invalid, duplicate, or over-budget events do not run.

The acceptance test is concrete:

1. Create a GitHub webhook automation from chat.
2. Copy its URL and secret into a repository hook.
3. A real push or issue event starts a turn in the target chat and the reply appears.
4. A duplicate delivery is recorded and does not run twice.
5. A bad signature is rejected.
6. A watched URL runs once when its content changes and does nothing when it does not change.
7. An interval automation fires on time, and pause stops it.
8. The Automations page shows triggers, events, runs, errors, and next run times.

## Why a separate AutomationAgent

The current `tasks` table and alarm live on the main Federation DO. They are a small fixed scheduler: one-off and daily instructions, always in main, no event, no dedupe, no conditions, no run history. Extending that table would mix an event log and watcher state into the session index and would make main's alarm do two unrelated jobs.

Use a singleton `AutomationAgent` Durable Object, bound as `AUTOMATION`:

- Owns triggers, events, runs, watcher state, secrets, counters, and its own alarm.
- Is the only writer of automation state.
- Runs no model and no tools; it submits turns to an existing session and records their outcomes.
- Keeps the old `tasks` scheduler untouched. The UI shows old scheduled jobs in a Scheduled section while triggers live in the new page. Migration into triggers can happen later.

## Goals

- Create, edit, pause, resume, delete, and rotate the secret for automations.
- Sources: generic webhook, GitHub webhook with HMAC, URL watcher with change detection, interval and daily time triggers.
- Per-automation target session, instructions, condition, cooldown, hourly cap, and failure state.
- Durable event store with provider delivery ids, payload hash, conditions, and run links.
- Durable run store with stream id, operation id, status, reply excerpt, error, attempts, timings.
- Deduplicate provider retries and duplicate deliveries.
- Never rerun a completed turn automatically. Only a submission that never started may retry.
- A user can preview the prompt and conditions before firing.
- All ingress is authenticated by a per-automation secret; GitHub uses HMAC-SHA256.
- Event payloads are untrusted. Event-origin turns cannot use the human-only `run:` directive bypass.
- Rate limits, body caps, and retention protect the free tier.
- The UI makes the webhook URL, last event, last run, and last error obvious.

## Non-goals

- Email ingress in the first milestone. Cloudflare Email Routing requires a domain and a Worker email handler; it is Phase 3B.
- Browser automation or scraping JavaScript-rendered pages. A watcher fetches HTTP content only.
- OAuth subscriptions such as Gmail push or Google Calendar watches. Phase 3C.
- The autonomy goal runtime. A trigger runs a chat turn in this project; later it can start a goal instead.
- Visual workflow graphs, multi-step branching, transformations, or arbitrary scripts as triggers.
- A public multi-tenant webhook service. This is a personal install with one owner.
- Regex conditions. They are a ReDoS risk and are not needed for the first version.

## Anti-goals

- A public webhook URL with no secret.
- Trusting a provider's event payload as instructions.
- Retrying a completed turn that already used tools.
- Storing or logging raw secrets, signatures, or full headers.
- Polling every minute for every watcher and burning the free tier.
- A trigger that keeps firing after a target session is gone.
- A run marked done because a submission returned, not because the turn finished.

## Architecture

```
inbound hook ──► /hooks route ──► AutomationAgent.ingest
                                      │
                                      ├─ auth (secret/HMAC)
                                      ├─ body cap + parse
                                      ├─ dedupe by event key
                                      ├─ condition match
                                      ├─ rate limit / cooldown
                                      ├─ event row
                                      └─ submitTurn to target session
                                             │
                                      FederationAgent turn
                                             │
                                      finalizeTurn callback
                                             │
                                      AutomationAgent.completeRun
```

Watchers and schedules use the same event and run path, with the alarm creating events instead of an HTTP request.

### New runtime pieces

- `AutomationAgent` singleton DO, name `"automation"`, binding `AUTOMATION`.
- Public route family `POST /hooks/:id/:secret` for generic webhooks and `POST /hooks/:id` for GitHub HMAC. No bearer. These routes only accept declared triggers.
- Authenticated route family `/api/automations...` for the console and agent.
- Three agent tools: `automation_create`, `automation_status`, `automation_control`.
- A session origin marker and completion callback so a trigger run can be tied to a turn without polling SSE.

### Target session rules

- Every automation targets one existing session, default `main`.
- A target session is validated against the registry at creation and at every run.
- At most one active automation run per target session. More events queue behind it.
- If the session is missing at fire time, the event is failed with `session_missing`, the automation stores the error, and the UI shows it. It does not silently recreate a chat.
- The trigger prompt is a normal user message in that session. It starts with `[Automation: <name>]`. The assistant reply is a normal assistant row.

### Event-origin safety

`submitTurn` gains an optional `origin`:

```ts
type TurnOrigin =
  | { kind: "human" }
  | { kind: "automation"; automationId: string; runId: string };
```

The existing HTTP message route always passes `human`. The AutomationAgent passes `automation`.

When origin is automation:

- `streamDirect()` is skipped, even if the rendered prompt starts with `run:`, `exec:`, or `execute:`. Only a human message may use the directive bypass.
- The prompt already carries the automation marker and the untrusted-data warning.
- The run completion callback is registered.

This is the primary prompt-injection and privilege-escalation guard.

## Data model

All tables live in `AutomationAgent` SQLite. Dates are epoch milliseconds. Secrets are encrypted at rest with the existing `encryptSecret` helper and the deployment's `AGENT_API_KEY`; they are never returned by list routes.

`automations`:

- `id TEXT PRIMARY KEY`
- `name TEXT NOT NULL`
- `kind TEXT NOT NULL` (`webhook`, `github`, `watch`, `schedule`)
- `enabled INTEGER NOT NULL DEFAULT 1`
- `target_session_id TEXT NOT NULL`
- `instructions TEXT NOT NULL` (user-authored instruction, capped 8 KB)
- `source_json TEXT NOT NULL` (URL, interval, dailyAt, provider metadata)
- `match_json TEXT` (conditions, capped 8 KB)
- `secret_enc TEXT` (encrypted ingress secret)
- `secret_hint TEXT` (last 4 chars, for display only)
- `cooldown_ms INTEGER NOT NULL`
- `max_per_hour INTEGER NOT NULL`
- `next_run_at INTEGER`
- `last_event_at INTEGER`
- `last_run_at INTEGER`
- `last_error TEXT`
- `consecutive_failures INTEGER NOT NULL DEFAULT 0`
- `created_at`, `updated_at`

`automation_events`:

- `id TEXT PRIMARY KEY`
- `automation_id TEXT NOT NULL`
- `event_key TEXT NOT NULL` (provider delivery id or hash)
- `source TEXT NOT NULL`
- `event_type TEXT`
- `payload_json TEXT` capped at 32 KB
- `headers_json TEXT` capped and redacted
- `status TEXT NOT NULL` (`received`, `matched`, `skipped`, `duplicate`, `rate_limited`, `queued`, `running`, `done`, `failed`, `session_missing`)
- `reason TEXT`
- `run_id TEXT`
- `created_at`, `updated_at`

Unique index: `(automation_id, event_key)`. This is what makes duplicate deliveries safe.

`automation_runs`:

- `id TEXT PRIMARY KEY`
- `automation_id TEXT NOT NULL`
- `event_id TEXT NOT NULL`
- `session_id TEXT NOT NULL`
- `stream_id TEXT`
- `operation_id TEXT`
- `status TEXT NOT NULL` (`submitting`, `running`, `done`, `failed`, `abandoned`)
- `reply TEXT` capped at 4 KB
- `error TEXT`
- `attempts INTEGER NOT NULL DEFAULT 0`
- `started_at`, `finished_at`, `created_at`

`automation_watch_state`:

- `automation_id TEXT PRIMARY KEY`
- `fingerprint TEXT`
- `last_value TEXT` capped at 4 KB
- `last_checked_at INTEGER`
- `last_status INTEGER`
- `consecutive_errors INTEGER NOT NULL DEFAULT 0`

`automation_rate`:

- `automation_id TEXT NOT NULL`
- `window_start INTEGER NOT NULL`
- `count INTEGER NOT NULL`
- PRIMARY KEY `(automation_id, window_start)`

`automation_meta`:

- `key TEXT PRIMARY KEY`, `value TEXT`
- holds schema version and the global pause flag.

Retention: prune events and runs older than 30 days or beyond 5,000 rows per automation, whichever first, plus rate windows older than 24 hours. The alarm does the pruning.

## Trigger sources

### Generic webhook

- Endpoint: `POST /hooks/:id/:secret`.
- `id` is the automation id; `secret` is the generated 32-byte base64url string.
- The route rejects unknown id, invalid secret, oversized body, and non-POST methods.
- Body cap: 128 KB. Store at most 32 KB of payload.
- Event key: `X-Event-Id`, `Idempotency-Key`, or sha256(raw body). Provider delivery headers are stored but redacted.
- Content type can be JSON or text. JSON is parsed for conditions; text is stored as `{ text }`.
- Response: 202 accepted, 200 duplicate, 401 invalid, 404 unknown, 413 too large, 429 rate limited. Do not echo the secret.

### GitHub webhook

- Endpoint: `POST /hooks/:id`.
- Requires `X-Hub-Signature-256: sha256=<hex>`.
- Verify HMAC-SHA256 over the raw body with the decrypted automation secret, using a constant-time comparison.
- Event key: `X-GitHub-Delivery`; event type: `X-GitHub-Event`.
- `X-Hub-Signature` (SHA1) is rejected; modern GitHub uses SHA256.
- Missing signature, bad signature, or missing delivery id is rejected. A missing delivery id falls back to the body hash.
- Store only the event type, delivery id, selected payload fields? Store the full JSON capped at 32 KB. Headers are redacted.

### URL watcher

- Config: `{ url, interval_minutes, fire_on_first?, method?: "GET", headers?: {"Name":"value"} }`.
- Minimum interval: 5 minutes; default 15.
- Fetch: `http` or `https` only, no embedded credentials, no localhost or private IP literals, 10-second timeout, 256 KB response cap.
- Fingerprint: sha256 of the raw response up to the cap. For JSON, parse and stable-stringify before hashing so key order does not create false changes.
- First successful check seeds the fingerprint and does not fire unless `fire_on_first` is true.
- After that, a changed fingerprint creates an event with payload `{ url, status, body, changed: true, previousHash }`. No change creates no event.
- Conditions run on `{ url, status, body, changed }`.
- HTTP errors are stored as `last_error`, increment consecutive errors, and do not create a run. Ten consecutive errors auto-pause the automation and write a visible reason.
- The watcher does not render HTML or run JavaScript. It is not a browser.

### Schedule

- Config: `{ every_minutes }` or `{ daily_at: "HH:MM" }` in UTC.
- Minimum interval: 5 minutes.
- Event key: `schedule:<dueAt>`; payload `{ scheduledAt, previousRunAt }`.
- No condition is required; conditions may inspect `scheduledAt`.
- The alarm computes the next due time from the current time, not from completion time, so a slow run does not drift a daily schedule.
- This is separate from the old `schedule_task`; the UI shows old tasks under Scheduled and new triggers under Automations.

## Conditions

A small data-only matcher, no code execution:

```json
{
  "all": [
    { "path": "action", "op": "eq", "value": "opened" },
    { "path": "issue.labels", "op": "contains", "value": "bug" }
  ]
}
```

Supported operators: `eq`, `neq`, `contains`, `startsWith`, `endsWith`, `exists`, `gt`, `lt`, `in`.

- Paths are dot-separated segments, arrays can be indexed with numeric segments.
- Arrays support `contains` for a value.
- Missing paths fail `exists` and every comparison except `neq`.
- Values are JSON primitives or arrays of primitives.
- `all` and `any` can nest one level; the total node count is capped at 32.
- No regex, no function calls, no templates.

For a watcher, use paths `body`, `status`, `changed`, `url`. For a webhook, use the provider payload. For a schedule, use `scheduledAt` and `previousRunAt`.

## Run protocol

1. Ingest validates auth, cap, parse, dedupe, condition, cooldown, and rate.
2. If accepted, insert the event as `queued`, compute the prompt, and (if no active run for the target) call the target session's `submitTurn` with origin automation and run id.
3. On acceptance, store `streamId`, `operationId`, status `running`, set `last_run_at`, and increment the rate window.
4. The session runs a normal turn. `finalizeTurn` calls `AUTOMATION.completeRun({runId, status, reply, error, artifacts, usage})`.
5. `completeRun` checks the run id and status, updates the run and event, increments unread on the target session, and records the result.
6. If the callback is lost, the alarm calls the session's `turnStatus(streamId)` after a stale threshold (15 minutes) and reconciles once.
7. A submission failure before acceptance retries with backoff 1 min, 5 min, and 15 min, max 3 attempts. A completed turn with a model/tool error is `failed` and is not auto-retried. The user can retry manually.
8. An event whose target is busy stays `queued` and is retried by the alarm. Queue cap: 20 events per automation and 50 globally. Over the cap, new deliveries are `rate_limited` with a clear reason.

Manual retry creates a new run for the same event, with a new run id, and is audited. It never reuses a stream id.

## Rate limits and quotas

Defaults per automation:

- Cooldown: 10 seconds.
- Maximum fires: 20 per rolling hour.
- Queue cap: 20 events.
- Maximum stored payload: 32 KB.
- Maximum watcher checks: interval floor 5 minutes.
- Consecutive watcher errors before auto-pause: 10.

Global:

- 2 running automation turns at once.
- 50 queued events.
- 200 automation runs per day.
- One alarm per AutomationAgent, clamped to 60 seconds; watcher due checks are batched.

These are conservative defaults for the free tier. They are constants in one module, not spread through the code.

## UI

Navigation: add **Automations** to the sidebar. Keep the existing Tasks page as Scheduled inside it, or keep both nav items temporarily; the chosen first implementation is one **Automations** page with two sections, Triggers and Scheduled, to avoid a seventh item. If the old Tasks route is kept, it becomes a redirect/link.

Automations page:

- header: global pause, New automation
- trigger cards: name, kind, enabled toggle, target chat, last event, last run, next run, last error
- filter: All, Webhooks, Watchers, Schedules, Paused
- empty state with three templates: GitHub webhook, URL watcher, scheduled brief

Automation detail:

- source summary and target chat link
- webhook URL with Copy and Rotate secret. The secret is shown once at creation and after rotation, never in the list.
- instructions preview and condition summary
- pause/resume, delete, preview prompt
- events timeline and runs timeline, newest first
- last error and auto-pause reason
- for watchers: last checked, last fingerprint change, next check
- for schedules: next due time

Activity panel:

- latest automation run with automation name, run status, and a link
- blocked/failed runs show Needs you
- unread badge on the target session, not a separate counter for each event

Chat:

- the user row begins with `[Automation: <name>]`
- the assistant reply is a normal assistant row
- no extra model call and no duplicate result message

Mobile:

- full-width Automations list and detail, no inspector
- webhook URL wrapping and a copy button that works on mobile
- create form in a full-screen sheet

## Routes

Public, no bearer:

- `POST /hooks/:id/:secret` generic webhook
- `POST /hooks/:id` GitHub webhook HMAC

Authenticated, bearer:

- `GET /api/automations?status=&kind=`
- `POST /api/automations`
- `GET /api/automations/:id`
- `PATCH /api/automations/:id`
- `DELETE /api/automations/:id`
- `POST /api/automations/:id/control` with `pause`, `resume`, `rotate_secret`, `retry_event`, `preview`
- `GET /api/automations/:id/events?after=`
- `GET /api/automations/:id/runs`
- `GET /api/automations/attention`

Validation: automation ids are opaque 12-32 char lowercase hex; target session must exist in the registry; instructions, names, and JSON caps are enforced server-side; raw secrets never appear in GET responses.

## Tools

Three tools:

- `automation_create({name, kind, target_session_id?, instructions, source, match?, cooldown_ms?, max_per_hour?})` returns the automation id and, once, the webhook URL/secret when applicable.
- `automation_status({id?})` returns one or a list with safe fields only.
- `automation_control({id, action, note?})` with pause, resume, rotate_secret, preview. Delete is UI-only and requires a confirmation; the agent can pause but not destroy.

`EXPECTED_TOOLS` becomes eleven. The capability table gets an Automations row. The tool descriptions explain the three sources and the fact that a trigger runs a turn in the target chat.

## Security

- Every public trigger has a secret. There is no unauthenticated source.
- Secrets are encrypted at rest with the existing agent-key-derived AES-GCM helper. List routes return only a hint.
- URL secrets are compared with the existing constant-time `safeEq` after decryption.
- GitHub HMAC is verified over the raw body with WebCrypto and a constant-time byte compare.
- Body caps are checked before JSON parsing and before storage.
- Event payloads and headers are untrusted. The prompt labels them as data.
- Event-origin turns skip the deterministic directive path. This is tested with a prompt containing `run:` and an assertion that no command ran.
- Target sessions are existence-checked; there is no orphan DO instantiation from a webhook.
- Watcher URLs are validated before fetch. Private IP literals, localhost, credentials, and non-http(s) schemes are rejected.
- Raw secrets, signatures, and full headers are never logged or stored in event payloads.
- No automation can change its own secret, rate limit, or target from an event turn.
- Rate limits fail closed; a provider storm becomes `rate_limited` events, not a model spend storm.
- The AutomationAgent never executes tools itself.

## Deferred: email ingress

Phase 3B, after the first milestone:

- Add a Cloudflare Email Routing `email()` handler.
- Per-automation random address `automation-<id>@<domain>` plus a sender allowlist.
- Parse `from`, `to`, `subject`, and text/plain; store raw size and a capped text body.
- Event key from `Message-ID`; dedupe repeated deliveries.
- Replies are sent only through an explicit automation action, never automatically.
- Requires a domain on Cloudflare. The UI must show a clear setup state until it is configured.

Phase 3C can add OAuth webhook subscriptions such as Gmail or Calendar. Those are separate connectors, not part of this plan.

## Failure handling

- Invalid auth: 401, no event.
- Oversized body: 413, no event.
- Duplicate event key: 200 duplicate, no new run.
- Condition false: event stored `skipped`, no run.
- Rate limited: event stored `rate_limited`, no run, last_error visible.
- Target session missing: event `session_missing`, no DO is created.
- Submission failure: retry with backoff up to three times, then `failed`.
- Turn error: `failed`, no auto retry; manual retry available.
- Watcher HTTP error: last_error, consecutive count, auto-pause at ten.
- Alarm failure: catch, record, re-arm; never let one bad trigger stop the whole tick.
- Duplicate callback: ignored by run id/status.
- Stale running run: reconcile with `turnStatus` after 15 minutes; mark abandoned if the session has no terminal state.
- Deleting a trigger: stop future fires, keep events/runs for audit, abort any running turn? No, a running turn is not killed by deletion; the run is marked abandoned and remains visible.

## Testing

Offline:

- store tests with real `node:sqlite`: schema, create/list/update, unique event key, rate windows, pruning.
- condition matcher tests: nested all/any, arrays, missing paths, caps, no code execution.
- security tests: secret generation/encryption, constant-time compare behavior, GitHub HMAC valid/invalid, body caps, URL guard.
- schedule tests: interval floor, daily UTC next run, no drift from completion time.
- watcher tests: first check seeds, unchanged no event, changed event, JSON stable hash, error auto-pause.
- route tests: public hook auth, duplicate, 413, 429, invalid id, bearer on management routes.
- tool tests: create/status/control descriptions and payloads, `EXPECTED_TOOLS` and capability row.
- session origin tests: automation origin skips directives; human origin still supports them.
- callback tests: complete run, duplicate ignored, stale reconciliation.
- UI source checks and `node --check` on the extracted script.
- live script: create webhook from API, post a signed event, wait for a reply, duplicate it, reject a bad secret.

## Deployment

- New DO binding `AUTOMATION` and class export.
- New schema in the AutomationAgent; no changes to existing Federation schema except the optional origin parameter and completion callback.
- Public hook routes must be routed before static assets.
- Deploy both trees; run the existing 38-test suite plus the new tests; run a live webhook and a live watcher.
- No push unless asked.

## Decisions

- Separate AutomationAgent, not the main task scheduler.
- Three trigger kinds in the first milestone: webhook/GitHub, watcher, schedule.
- One target session per automation; default main; no session creation.
- Event-origin turns cannot use directives.
- GitHub HMAC and per-trigger secret; no public unauthenticated ingress.
- No email in the first milestone; Phase 3B.
- No browser or JavaScript-rendered watcher.
- No automatic retry after a completed turn.
- One Automations nav page with a Scheduled section.
- Secrets encrypted with the existing model-secret helper.
- Rate limits are per automation and global, with no silent overage.
