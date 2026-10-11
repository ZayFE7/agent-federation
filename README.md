# agent-federation

A personal AI agent deployed as a federation of free, no-card services.

- Cloudflare Workers Free + Durable Objects + Agents SDK is the always-on agent brain (persistent memory in DO SQLite, alarm-based autonomous ticks).
- Pipedream free Python workflow is the OpenAI-compatible model router in front of the user's cloud model providers.
- Sandbox execution comes later behind an interface.

## Architecture

```
  +--------+        +--------------------------------------+
  |  UI /  |  HTTP  |  Worker (src/index.ts)              |
  | client +-------->  GET  /health                        |
  |        |  WS    |  POST /api/message                  |
  +--------+        |  WS   /   {type:"chat",...}         |
                    +------------------+-------------------+
                                       |  stub / idFromName
                                       v
                    +--------------------------------------+
                    |  FederationAgent (DO, SQLite memory) |
                    |  this.sql.exec(...) storage          |
                    |  schedule("1 minute") alarms         |
                    +------------------+-------------------+
                                       |  POST + X-Tier header
                                       v
                    +--------------------------------------+
                    |  Pipedream router (Python, free)     |
                    |  OpenAI chat-completions passthrough |
                    +------------------+-------------------+
                                       |
                    +----------+-------+----------+
                    v          v                  v
               primary     cheap tier        jev tier
               provider    provider          provider
```

## Quickstart

```sh
npm install
cp .dev.vars.example .dev.vars
# fill in .dev.vars: ROUTER_URL, ROUTER_KEY, AGENT_API_KEY
npm run dev
```

Deploy:

```sh
npx wrangler login
# set ROUTER_URL in the vars block of wrangler.jsonc (MODEL_* defaults are fine)
wrangler secret put ROUTER_KEY
wrangler secret put AGENT_API_KEY
npm run deploy
```

Typecheck:

```sh
npm run typecheck
```

## HTTP surface

- `GET /health` returns `{ok:true}`.
- `POST /api/message` with bearer `AGENT_API_KEY`, body `{content: string, tier?: "primary"|"cheap"}` returns `{reply: string}`.
- WebSocket at `/` accepts the same JSON messages: `{type:"chat", content, tier}`.

## Router contract

The Worker POSTs an OpenAI chat-completions JSON body to `ROUTER_URL` with header `X-Tier: primary|cheap|jev`. The router responds with standard OpenAI chat-completions JSON (non-stream MVP). The router may check `Authorization: bearer <ROUTER_KEY>` if that env is set on its side.

Router env (Pipedream): `ROUTER_KEY` (optional), `PRIMARY_BASE_URL`, `PRIMARY_API_KEY`, `PRIMARY_MODEL`, `CHEAP_BASE_URL`, `CHEAP_API_KEY`, `CHEAP_MODEL`, optional `JEV_BASE_URL`, `JEV_API_KEY`, `JEV_MODEL`.

Worker env vars: `ROUTER_URL`, `ROUTER_KEY`, `MODEL_PRIMARY` (default `meta/muse-spark-1.3`), `MODEL_CHEAP` (default `meta/muse-spark-1.3-contributor`), `AGENT_API_KEY`.

## Connector checklist

Things you need to connect before this runs end to end:

- [ ] Cloudflare account + `npx wrangler login` (Workers Free tier).
- [ ] Pipedream account + a deployed workflow exposing `ROUTER_URL`.
- [ ] Provider keys for the model tiers (primary, cheap, and later jev).
- [ ] Set secrets: `wrangler secret put ROUTER_KEY`, `wrangler secret put AGENT_API_KEY`.
- [ ] Later: E2B account for sandbox execution behind the sandbox interface.

## TODO (supervisor and workers)

- Supervisor/worker fanout across multiple Durable Object instances.
- Streaming responses from the router (optional bonus).
- Sandbox execution behind an interface (E2B or similar).
- Richer memory schema in DO SQLite beyond the MVP chat log.
- Autonomous tick scheduling beyond the 1 minute alarm.
