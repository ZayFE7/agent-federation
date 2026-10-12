# Telegram bridge

Gives Blip a mouth: replies to your Telegram messages from the agent brain,
runs on a 1-minute cron (no inbound URL needed), tracks update offsets in KV.

## Setup (2 minutes, free)

1. In Telegram, talk to **@BotFather** → `/newbot` → follow prompts → copy the **bot token**.
2. Tell me the token; I will:
   - create the KV namespace
   - upload secrets (TELEGRAM_BOT_TOKEN, AGENT_API_KEY)
   - deploy the worker
3. Open your new bot in Telegram, send `/start`, then just talk to it.

## Endpoints

- `GET /health` - liveness
- `POST /poll` - force an immediate poll (cron already does this every minute)

## Notes

- State suffix `[verb]` on replies mirrors the console mascot (envelope verb).
- `/state` shows the last known agent state.
- Cron minute cadence keeps latency of background replies under ~60s; live chat
  feels instant because replies are processed the moment the update arrives.
