# Router capability probe: which model ids can tool-call and stream

Task 2 of the agent-loop-upgrade plan. Produced by `tests/router-probe.mjs`
(run from the deploy tree against the LOCAL router; `.dev.vars` `ROUTER_URL`
is a 127.0.0.1 address, the same omniroute the production worker reaches
through the rotating cloudflared tunnel). Raw rows:
`.superpowers/sdd/2026-10-18-agent-loop-upgrade/task-2-evidence.txt` (redacted;
every URL and key value is scrubbed by the script at print time).

## Why this exists

Production was dead before this: both `MODEL_PRIMARY` and `MODEL_CHEAP` were
configured as `cf/@cf/qwen/qwen3.8-27b`, an id the live router rejects, so
`/api/decide` 500d and no later task in the plan could be tested. The agent
loop needs two independent properties per id: it answers a tool call, and the
response streams. The probe measures four phases per id:

- `tool`: non-stream, pass = HTTP 200 and
  `choices[0].message.tool_calls[0].function.name === "echo_probe"`.
- `stream`: pass = HTTP 200, `text/event-stream`, >=3 `data:` events, and
  streamed tool-call argument fragments that reassemble into valid JSON.
- `deltas`: same tool call with `stream_options.include_only_deltas = true`;
  reported, not part of any rule (BLIP controls whether we send it).
- `toolseen`: the model's own tool call replayed verbatim in history plus a
  tool result, then a final turn only answerable from that result.

BOTH-PASS (the brief's bar) = tool ok AND stream ok. LOOP-READY = BOTH-PASS
AND toolseen ok, the bar for choosing between two both-pass ids because
Phase 2 is a multi-turn tool loop.

## Measured table (first pass, each id run once)

| id | tool | stream | deltas | toolseen | http | cost (x-omniroute-response-cost) | why |
|---|---|---|---|---|---|---|---|
| gemini3.7flash | ok | ok (7 events, args reassembled) | ok | FAIL | 200 | 0.0002955 | 2nd turn: empty content + 1 new tool_call (see retest) |
| gemini3.8flash | ok | ok (5 events) | ok | ok | 200 | 0.0000000 | LOOP-READY on the first pass |
| opus5 | FAIL | FAIL | FAIL | skipped | 429/503 | none returned | rate limit, "All credentials for claude-opus-5 cooling down", then all targets skipped |
| opus5thinking | FAIL | FAIL | FAIL | skipped | 429/503 | none returned | same as opus5 |
| z-ai/glm-5.1 | FAIL | FAIL | FAIL | skipped | 401 | none returned | router: "No active credentials for provider: z-ai" |
| moonshotai/kimi-k2.6 | FAIL | FAIL | FAIL | skipped | 404/401 | none returned | 404 model_not_found, then "No active credentials for provider: nvidia" |
| deepseek-ai/deepseek-v4-pro | FAIL | FAIL | FAIL | skipped | 401 | none returned | "No active credentials for provider: deepseek-ai" |
| qmodel_latest | FAIL | FAIL | FAIL | skipped | 401 | none returned | "No active credentials for provider: qd" |

Only the two gemini ids both-pass. The six failures are router-side
credential or capacity state, not measured model capability: an id the router
cannot dispatch to a provider was never actually asked anything. opus5 and
opus5thinking answer "reset after 1s" on the 429, so they are worth one rerun
on a quiet hour if someone wants a Claude tier in the loop; that is not
required by this task. qmodel_latest, the moving alias in the candidate set,
dies on provider credentials before alias stability even becomes a question,
so the R-E "only a latest alias works" risk did not materialize. Both chosen
ids are pinned.

## The toolseen retest (one extra pass, script change)

`gemini3.7flash` failed `toolseen` with `second-turn content EMPTY,
second-turn tool_calls 1`: it re-called the tool instead of reading its own
result. That is the ambiguous failure shape (a model that cannot parse its own
call vs one that ignored an under-specified follow-up), so one extra pass was
spent re-testing the two both-pass ids after making the final instruction in
`roundTripBody` unambiguous. Change (repo-clone, `tests/router-probe.mjs`,
documented in a comment at the change site):

- old: `The tool returned. Reply with only the value of its echoed field.`
- new: `The tool call above returned a result. Answer only from that tool
  result: reply with the exact value of its "echoed" field and nothing else.
  Do not call any tool again.`

Only `roundTripBody` was touched; phases 1 to 3 are untouched, so the first
pass remains comparable. Retest result: `gemini3.7flash` toolseen ok,
`gemini3.8flash` still ok (tool row cost 0.0002842500 and 0.0000000000
respectively, matching the first pass). Final verdicts:

| id | tool | stream | deltas | round-trip | BOTH-PASS | LOOP-READY |
|---|---|---|---|---|---|---|
| gemini3.7flash | ok | ok | ok | ok | YES | YES |
| gemini3.8flash | ok | ok | ok | ok | YES | YES |

Caveat carried into Phase 2: `gemini3.7flash` needed the stronger instruction
to complete the round trip, so the loop's continuation prompts should state
explicitly that a tool result must be answered from, not left implicit.

## Which provider served each id

`x-router-conn` is absent on every probed response (the script prints
`conn none` per row; it reads only that header). So the probe cannot attribute
ids to connections through it. The only provider evidence available is what
the router itself echoed: response bodies return the upstream model name
(`"model":"gemini-3.7-flash"` on the gemini3.7flash rows), and dispatch errors
name providers in plaintext (`JDW/claude-opus-5` for the opus ids, `z-ai`,
`nvidia`, `deepseek-ai`, `qd` for the credential failures). Recording the
absence rather than inventing an attribution: for the two chosen ids we know
the upstream id, not the credential/connection that served it.

## The choice, with cost evidence

- `MODEL_PRIMARY = "gemini3.7flash"`: both-pass, LOOP-READY, pinned,
  measured 0.0002955 / 0.0002842500 per probe call.
- `MODEL_CHEAP = "gemini3.8flash"`: both-pass, LOOP-READY, pinned, measured
  0.0000000000 (free tier), strictly cheaper than PRIMARY by the header
  numbers above.

The brief requires the two ids to differ and CHEAP to be strictly cheaper.
Only two ids both-pass, and the measured-cost ordering forces exactly this
assignment (nothing is cheaper than 0.0, so 3.8flash cannot be PRIMARY while
keeping a cheaper partner). Watch item: 3.8flash answering at zero cost may be
a promotional or free tier with its own rate limits; if it starts 429ing, the
pair can be flipped only after re-probing, since no third both-pass id exists
today.

## Standing note: the router does no body translation

The omniroute forwards the OpenAI-shape request body to the upstream without
OpenAI/Anthropic translation. An id's tool-calling behavior is therefore the
upstream's, not the router's: the failures above were dispatch-time (no
credentials, cooling), and everything observed about tool-call shape, delta
behavior, and round-trip handling belongs to the upstream model behind the id.

## Reproducing

From the deploy tree (ids on argv; nothing is probed unless named, and keys
are read at runtime and never printed):

```bash
BLIP_ROUTER_URL=$(grep -E "^ROUTER_URL=" .dev.vars | cut -d= -f2-) \
  node tests/router-probe.mjs gemini3.7flash gemini3.8flash
```

The file is `tests/router-probe.mjs`, deliberately not `*.test.mjs`, so
`npm test` never runs it and it never spends router credits on a test run.
