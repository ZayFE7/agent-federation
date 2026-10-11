# Pipedream model router

Turns one Pipedream HTTP workflow into an OpenAI-compatible model router.
The Cloudflare Worker posts here with an `X-Tier` header; the workflow picks
the provider env trio for that tier, rewrites `model`, and passes the provider
response straight back.

## 1. Create the workflow

1. Go to https://pipedream.com and create a new workflow.
2. Add trigger: **HTTP / Webhook** (HTTP Request trigger). This gives you a URL
   like `https://your-username.us-east-1.pipedream.net/<slug>`.
3. Add step: **Python** (Code step, Python 3.12).
4. Paste the whole of `router.py` into that step. The entrypoint is
   `handler(pd)`; set the step's return expression to `handler(pd)`.
5. On the **HTTP trigger** step, turn on custom responses (the setting is on
   the trigger, labelled something like "Respond with a custom response").
   Without it Pipedream sends its default body and the Worker will not see
   OpenAI chat-completions JSON.

The trigger event (`pd.steps["trigger"]["event"]`) has `headers`, `body` and
`path`. `handler(pd)` reads that event and answers the HTTP request with
`pd.respond(...)`, returning a Pipedream response object:

```python
{"status": int, "headers": {...}, "body": {...}}
```

`handler` also accepts a raw event dict, so you can smoke-test it outside
Pipedream by calling `handler({"headers": {...}, "body": {...}})` from any
Python 3.12 interpreter.

## 2. Set the workflow env vars

Open **Workflow settings -> Environment variables** and add:

| Name | Required | Notes |
| --- | --- | --- |
| `ROUTER_KEY` | optional | shared secret; if set, the caller must send `Authorization: Bearer <ROUTER_KEY>` |
| `PRIMARY_BASE_URL` | yes | provider base URL, e.g. `https://openrouter.ai/api/v1` |
| `PRIMARY_API_KEY` | yes | provider key for that base URL |
| `PRIMARY_MODEL` | yes | default `meta/muse-spark-1.3` |
| `CHEAP_BASE_URL` | yes | e.g. `https://openrouter.ai/api/v1` |
| `CHEAP_API_KEY` | yes | provider key |
| `CHEAP_MODEL` | yes | default `meta/muse-spark-1.3-contributor` (placeholder) |
| `JEV_BASE_URL` | optional | only needed if you send `X-Tier: jev` |
| `JEV_API_KEY` | optional | |
| `JEV_MODEL` | optional | |

Note: the router appends `/chat/completions` to `*_BASE_URL` unless the URL
already ends with it, so set the base URL without the path.

## 3. Copy the URL into the Worker

Take the trigger URL from step 1 and put it in the Worker config: for local
dev copy `.dev.vars.example` to `.dev.vars`; for deploy set `ROUTER_URL` in
the commented `vars` block of `wrangler.jsonc` and put the secret with
`wrangler secret put ROUTER_KEY`.

```dotenv
ROUTER_URL = "https://your-username.us-east-1.pipedream.net/<slug>"
ROUTER_KEY = "same-value-as-the-workflow-env-var"
```

## 4. Test it

PowerShell (Invoke-RestMethod):

```powershell
$body = @{
  model    = "ignored-on-router-side"
  messages = @(@{ role = "user"; content = "ping" })
  max_tokens = 16
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri "https://your-username.us-east-1.pipedream.net/<slug>" `
  -Method Post `
  -ContentType "application/json" `
  -Headers @{ "X-Tier" = "primary" } `
  -Body $body
```

curl:

```bash
curl -sX POST "https://your-username.us-east-1.pipedream.net/<slug>" \
  -H "Content-Type: application/json" \
  -H "X-Tier: cheap" \
  -d '{"model":"whatever","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'
```

Health check (no provider call):

```powershell
Invoke-RestMethod -Uri "https://your-username.us-east-1.pipedream.net/<slug>/health" -Method Get
# -> {"ok":true,"service":"router"}
```

Expected behaviour:

- `X-Tier: primary` -> uses `PRIMARY_*`, returns provider JSON with `model`
  forced to `PRIMARY_MODEL`.
- `X-Tier: cheap` -> uses `CHEAP_*`.
- `X-Tier: jev` and `JEV_*` unset -> `400 tier jev not configured`.
- unknown tier (`X-Tier: banana`) -> `400 unknown tier`.
- provider error -> status and body passed through untouched.
- bad/missing bearer when `ROUTER_KEY` is set -> `401`.

## 5. Free-tier limits (keep this as workflow #1)

- Free plan gives roughly 1 credit per active workflow; 1 credit buys about
  30 seconds of compute. A chat completion usually finishes inside that
  window, but a very long generation can hit it.
- The free plan allows only a few active workflows at once. Treat this router
  as workflow #1 and do not add a bunch of other always-on workflows next to
  it; deactivate experiments when you are done with them.
- Pipedream may pause workflows with no traffic. Send the health request once
  in a while (or from the Worker's `/health` probe) to keep it warm.
- Non-streaming only for the MVP. Streaming is an optional bonus later.

## TODO

- Streaming responses (`stream: true` pass-through) if the Worker wants tokens.
- JEV tier load balancing / failover to `PRIMARY_*` when `JEV_*` is empty.
- Per-tier request logging and simple rate limiting.
