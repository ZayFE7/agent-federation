# deploy/telegram-bridge

Gives BLIP a mouth outside the console: a Cloudflare Worker that long-polls nothing, but
cron-polls Telegram `getUpdates` every minute, forwards each inbound message to the brain's
`POST /api/message`, and sends the reply back with the mascot verb appended as a status
suffix. No inbound webhook URL and no public tunnel needed.

## It was scaffolded and never deployed

Verified from the files, not from memory:

- `wrangler.jsonc:6` still holds the literal placeholder KV id `PASTE_KV`, so a deploy could
  never have validated.
- No `tsconfig.json`, no `package.json`, no `.dev.vars` in this directory.
- `../../../memory/personal-agent-project.md` (line 23) says "Telegram bridge scaffold at
  deploy/telegram-bridge needs bot token + KV".
- The previous version of this README asked the reader to supply a token ("Tell me the
  token; I will create the KV namespace, upload secrets, deploy the worker"), i.e. none of
  that had happened.
- `_superseded/HANDOFF.md` records a 2026-10-16 cloud check: this worker answers 404, the
  other three exist.

## Routes and handlers (`src/index.ts`)

| Entry | Line | Behaviour |
|---|---|---|
| `GET /health` | 79 | `{ok:true, service:"telegram-bridge"}` |
| `POST /poll` | 83 | runs one poll cycle immediately (manual trigger between cron ticks) |
| other HTTP | 87 | `{error:"not found"}` 404 |
| `scheduled()` | 91 | same poll cycle, driven by the cron in `wrangler.jsonc:7` (`* * * * *`) |

`pollOnce()` (`:96-114`) reads the last processed `update_id` from KV key `offset`, calls
`getUpdates` with `timeout: 0` and `allowed_updates: ["message"]`, handles updates in order,
then stores `maxId + 1`. `handleUpdate()` (`:23-74`) ignores anything without `chat.id` or
`text`, answers `/start` with a fixed greeting (`:30`), answers `/state` from KV key
`lastState` (`:38`), otherwise forwards to `${AGENT_URL}/api/message` with
`{content, tier:"primary"}` (`:52-58`), writes `lastState`, truncates replies over 3900
chars (`:72`) and appends `  [verb]` (`:70`). A brain that cannot be reached yields
`network error: ...` as the reply text rather than a crash (`:64-66`).

## What it needs to come alive

1. A bot token from **@BotFather** (`/newbot`), used as secret `TELEGRAM_BOT_TOKEN`; the
   code builds `https://api.telegram.org/bot<token>/<method>` (`src/index.ts:12-21`).
2. Secrets `TELEGRAM_BOT_TOKEN` and `AGENT_API_KEY` (interface at `src/index.ts:5-10`).
   The bridge authenticates to the brain with `AGENT_API_KEY`, the same bearer the console
   uses (`src/index.ts:56`, enforced at `../../src/index.ts:42-46`).
3. A real KV namespace for binding `BRIDGE`, replacing `PASTE_KV` at `wrangler.jsonc:6`.
   `_superseded/HANDOFF.md` notes no `BRIDGE` namespace exists yet.
4. `AGENT_URL` (`wrangler.jsonc:9`, currently the deployed brain URL); update it if the
   brain is redeployed under a different name.
5. The cron is already declared (`wrangler.jsonc:7`); keep it, since the whole design is
   pull-based.

Names only, never values. Fresh values are mandatory: `../../../../SECRETS.md` and
`_superseded/secrets-checklist.md`.

## Not verifiable here

Whether a bot token ever existed beyond the transcripts, whether `update_id` offsets from
the old PC are still meaningful (they are not, after a token reissue), and real-world reply
latency (design target under ~60 s for background, near-instant for live chat).
