# Router capability probe: which model ids can tool-call and stream

Task 2 of the agent-loop-upgrade plan. Produced by `tests/router-probe.mjs`,
run from the deploy tree, where `.dev.vars` gives the probe its key and its
base URL. Fix round 1 note: the `toolseen` column below was measured under two
different criteria, and the rows say which.

## Which router layer each claim is about

There are two routers in this stack and they are not the same program, so every
claim in this file names its layer. This is the split documented in
`docs/explorations/live-test-report.md` section 5.2 ("Two routers, mismatched
catalogs"); it is cited here, not re-derived.

- The **measured layer** is the **local omniroute** at the loopback origin in
  `.dev.vars` `ROUTER_URL` (3300-plus entry catalog, count was 3309 at the fix
  round 1 run). Every table row in this file is a statement about that program.
  It is the only layer this script can reach offline.
- Production's LLM calls go through the **`ROUTER` service binding to the
  `zay-router` Worker**, which runs its own `resolve()` over aliases, combos,
  connection prefixes and `defaultModel`. The probe never reaches it: the
  cloudflared tunnel that used to carry chat is down, and as of HEAD chat no
  longer rides it either, because every LLM call site (`/api/decide` and both
  chat fetches) now goes through `fetchRouter`, which prefers the binding.
- Consequence: a `tool`/`stream`/`deltas`/`toolseen` verdict here is about the
  omniroute entry the id resolves to. It is not evidence that `zay-router`
  routes the same id, and the cross-check below is what closes that gap.

## Why this exists

Production was dead before this: both `MODEL_PRIMARY` and `MODEL_CHEAP` were
configured as `cf/@cf/qwen/qwen3.8-27b`. That id is routable on the local
omniroute but is not routable in `zay-router`, whose `resolve()` answers it 404
(`live-test-report.md` section 5.2 records exactly that mismatch), so
`/api/decide` 500d and no later task in the plan could be tested. The agent
loop needs two independent properties per id on the measured layer: it answers a
tool call, and the response streams. The probe measures four phases per id:

- `tool`: non-stream, pass = HTTP 200 and
  `choices[0].message.tool_calls[0].function.name === "echo_probe"`.
- `stream`: pass = HTTP 200, `text/event-stream`, >=3 `data:` events, and
  streamed tool-call argument fragments that reassemble into valid JSON.
- `deltas`: same tool call with `stream_options.include_only_deltas = true`;
  reported, not part of any rule (BLIP controls whether we send it).
- `toolseen`: the model's own tool call replayed verbatim in history, plus a
  tool result carrying a per-run nonce, then a final turn that can only be
  answered from that nonce.

BOTH-PASS (the brief's bar) = tool ok AND stream ok. LOOP-READY = BOTH-PASS AND
toolseen ok, the bar for choosing between two both-pass ids because Phase 2 is a
multi-turn tool loop.

The `toolseen` criterion has two versions in this file's history:

- **old (parrotable) criterion**, used by every row marked `[old]`: HTTP 200 and
  the second turn's text contains `ROUTER-PROBE-OK`. That token is what the
  first turn's instruction makes the model emit, and the script also supplies it
  in the tool result, so a model that merely repeated its own earlier output
  passed. The rule also ignored the second turn's `tool_calls` length, so a turn
  that answered correctly *and* re-called the tool passed too.
- **nonce criterion**, used by every row marked `[nonce]`: a fresh unpredictable
  value is generated once per script invocation and placed in the tool result
  only, never in the first turn and never spelled out in the final instruction
  (which names the field, not the value). Pass = HTTP 200 AND the second turn's
  text contains that nonce AND the second turn's `tool_calls` length is exactly
  0. `node tests/router-probe.mjs --selftest` checks offline that a repeat of
  turn 1 cannot satisfy it and that a re-call cannot either.

Rows marked `[skipped]` were never scored by either criterion: the router
refused to dispatch, so the model was never asked anything.

## Measured table (first pass on the local omniroute, each id run once)

| id | tool | stream | deltas | toolseen | criterion | http | cost (x-omniroute-response-cost) | why |
|---|---|---|---|---|---|---|---|---|
| gemini3.7flash | ok | ok (7 events, args reassembled) | ok | FAIL | [old] | 200 | 0.0002955 | 2nd turn: empty content + 1 new tool_call (see retest) |
| gemini3.8flash | ok | ok (5 events) | ok | ok | [old] | 200 | 0.0000000 | LOOP-READY on the first pass, under the parrotable rule |
| opus5 | FAIL | FAIL | FAIL | skipped | none | 429/503 | none returned | rate limit, "All credentials for claude-opus-5 cooling down (reset after 1s)", then all targets skipped |
| opus5thinking | FAIL | FAIL | FAIL | skipped | none | 429/503 | none returned | same as opus5 |
| z-ai/glm-5.1 | FAIL | FAIL | FAIL | skipped | none | 401 | none returned | omniroute: "No active credentials for provider: z-ai" |
| moonshotai/kimi-k2.6 | FAIL | FAIL | FAIL | skipped | none | 404/401 | none returned | 404 model_not_found on the local omniroute, then "No active credentials for provider: nvidia" |
| deepseek-ai/deepseek-v4-pro | FAIL | FAIL | FAIL | skipped | none | 401 | none returned | "No active credentials for provider: deepseek-ai" |
| qmodel_latest | FAIL | FAIL | FAIL | skipped | none | 401 | none returned | "No active credentials for provider: <an api-key relay connection, prefix withheld>" |

Read these `toolseen` cells conditionally. Only the two gemini rows carry a
`toolseen` verdict, both under `[old]`, and the `[old]` verdicts for them are
void as evidence of a round trip: that rule could be satisfied by echoing a
token already in the transcript. The `[skipped]` cells are not failures of the
models; no verdict of either kind was produced for those six ids.

Only the two gemini ids both-pass on this layer. The six failures are
omniroute-side credential, capacity or catalog state, not measured model
capability: an id the local omniroute cannot dispatch to a provider was never
actually asked anything, and the 404 for `moonshotai/kimi-k2.6` is a catalog
miss on that layer rather than a credential problem. opus5 and opus5thinking
answer "reset after 1s" on the 429, so they are worth one rerun on a quiet hour
if someone wants a Claude tier in the loop; that is not required by this task.
qmodel_latest, the moving alias in the candidate set, dies on provider
credentials on the local omniroute before alias stability even becomes a
question, and it is separately disqualified on the production layer (see the
cross-check below). Both chosen ids are pinned.

## The toolseen retest (one extra pass, script change, still the old criterion)

This retest ran on the local omniroute under `[old]`, so its conclusions about
the round trip are superseded by the nonce re-measurement below; what it
established stands only for the first-turn behavior it observed.

`gemini3.7flash` failed `toolseen` with `second-turn content EMPTY,
second-turn tool_calls 1`: it re-called the tool instead of reading its own
result. That is the ambiguous failure shape (a model that cannot parse its own
call vs one that ignored an under-specified follow-up), so one extra pass was
spent re-testing the two both-pass ids after making the final instruction in
`roundTripBody` unambiguous. Change (repo-clone, `tests/router-probe.mjs`,
documented in a comment at the change site):

- old: `The tool returned. Reply with only the value of its echoed field.`
- new: `The tool call above returned a result. Answer only from that tool
  result: ... Do not call any tool again.`

Fix round 1 kept that wording and changed only which field it names: the value it
asks for is now the per-run nonce, so the instruction still demands an answer
from the tool result and still forbids re-calling, but the token being repeated
is one the model never saw before that result.

Only `roundTripBody` was touched; phases 1 to 3 are untouched, so the first
pass remains comparable. Retest verdict, both rows `[old]`:
`gemini3.7flash` toolseen ok, `gemini3.8flash` still ok (tool row cost
0.0002842500 and 0.0000000000 respectively, matching the first pass).

## Nonce re-measurement (fix round 1, the sound criterion)

The instrument was fixed first (nonce in the tool result only, pass rule = HTTP
200 AND nonce present AND second-turn `tool_calls` length 0), then both pinned
ids were re-run against the local omniroute, four phases each. Two independent
runs were taken; both agree. These are the verdicts Phase 2 should read.

| id | tool | stream | deltas | toolseen | criterion | run 1 cost | run 2 cost |
|---|---|---|---|---|---|---|---|
| gemini3.7flash | ok 200 | ok 200, args reassembled (6 events run 1, 7 run 2) | ok 200 | ok | [nonce] | 0.0003292500 | 0.0003105000 |
| gemini3.8flash | ok 200 | ok 200, args reassembled (6 events run 1, 8 run 2) | ok 200 | ok | [nonce] | 0.0000000000 | 0.0000000000 |

Worded next to the table, because the criterion is part of the result: these
`toolseen` cells are the only `toolseen` evidence in this file that is not
satisfiable by parroting. The raw rows record, for each id, `nonce in
second-turn text present` and `old parrotable signal (turn-1 echo token in
second-turn text) absent`, plus `second-turn tool_calls 0` and
`second-turn finish_reason=stop`. That combination is the positive proof: the
model answered with a value it could only have read from the tool result, did
not repeat its own earlier token, and did not re-call the tool.

There is no LOOP-READY regression: both ids still pass, so `MODEL_PRIMARY` and
`MODEL_CHEAP` stay as pinned. What the fix did remove is the right to claim a
round trip from the earlier runs; the first-pass `FAIL` for `gemini3.7flash` and
the `[old]` `ok` for both ids are historical records of a broken instrument, not
of the models.

Final verdict table, restated with each row's criterion so no transcription can
lose it:

| id | tool | stream | deltas | round-trip | BOTH-PASS | LOOP-READY | round-trip criterion |
|---|---|---|---|---|---|---|---|
| gemini3.7flash | ok | ok | ok | ok | YES | YES | [nonce], current |
| gemini3.8flash | ok | ok | ok | ok | YES | YES | [nonce], current |
| gemini3.7flash | ok | ok | ok | FAIL then ok | YES | void | [old], superseded |
| gemini3.8flash | ok | ok | ok | ok | YES | void | [old], superseded |

Caveat carried into Phase 2: `gemini3.7flash` needed the stronger instruction
("answer only from that tool result ... Do not call any tool again") to complete
the round trip under either criterion, so the loop's continuation prompts should
state explicitly that a tool result must be answered from and that no new call
is wanted, rather than leave it implicit.

## Which provider served each id

`x-router-conn` is absent on every probed response (the script prints
`conn none` per row). The script reads only that one response header, so its
absence is evidence about the script's reach, not proof that the router never
emits it: a header the omniroute does set on some other path, or one stripped
between layers, would look identical here. So the probe cannot attribute ids to
connections through it. The only provider evidence available is what the router
itself echoed: response bodies return the upstream model name
(`"model":"gemini-3.7-flash"` on the gemini3.7flash rows), and dispatch errors
name providers in plaintext, using public builtin catalog names where the
provider is a public one (`z-ai`, `nvidia`, `deepseek-ai`) and a connection
whose personal relay identifier is withheld here (the `opus5` family and
`qmodel_latest` rows). Recording the absence rather than inventing an
attribution: for the two chosen ids we know the upstream id, not the
credential/connection that served it.

## Cross-check of the two layers for the chosen ids

Checked by hand against the `zay-router` configuration rather than by the probe:

- `gemini3.7flash` and `gemini3.8flash` are both `zay-router` **combos**, and
  each resolves to the builtin gemini provider with upstream models
  `gemini-3.7-flash` and `gemini-3.8-flash` respectively. The same upstreams the
  local omniroute reported in its echoed `model` field, so both layers land on
  the same upstream for both pinned ids and the probe's capability verdicts
  transfer to production traffic.
- `qmodel_latest` is **not routable in `zay-router` at all**. That disqualifies
  it from the pinned pair independently of the credential failure the table
  above records on the local omniroute: even with live credentials it could not
  be sent through the production layer.

## The choice, with cost evidence

- `MODEL_PRIMARY = "gemini3.7flash"`: both-pass on the local omniroute,
  LOOP-READY under the nonce criterion, pinned, measured 0.0003292500 /
  0.0003105000 per probe call on the fix round 1 runs (0.0002955 / 0.0002842500
  on the earlier runs).
- `MODEL_CHEAP = "gemini3.8flash"`: both-pass on the local omniroute,
  LOOP-READY under the nonce criterion, pinned, measured 0.0000000000 on every
  run (free tier), strictly cheaper than PRIMARY by the header numbers above.

The brief requires the two ids to differ and CHEAP to be strictly cheaper.
Only two ids both-pass, and the measured-cost ordering forces exactly this
assignment (nothing is cheaper than 0.0, so 3.8flash cannot be PRIMARY while
keeping a cheaper partner). Watch item: 3.8flash answering at zero cost may be
a promotional or free tier with its own rate limits; if it starts 429ing, the
pair can be flipped only after re-probing, since no third both-pass id exists
today.

## Standing note: neither router layer translates the body

The local omniroute forwards the OpenAI-shape request body to the upstream
without OpenAI/Anthropic translation, and the `zay-router` Worker does no body
translation either. An id's tool-calling behavior is therefore the upstream's,
not either router's: the failures above were dispatch-time on the omniroute (no
credentials, cooling, catalog miss), and everything observed about tool-call
shape, delta behavior, and round-trip handling belongs to the upstream model
behind the id.

## Reproducing

From the deploy tree (ids on argv; nothing is probed unless named, and keys are
read at runtime and never printed; the base URL is the loopback omniroute in
`.dev.vars`):

```bash
BLIP_ROUTER_URL=$(grep -E "^ROUTER_URL=" .dev.vars | cut -d= -f2-) \
  node tests/router-probe.mjs gemini3.7flash gemini3.8flash
```

The instrument itself is checkable without a network:

```bash
node tests/router-probe.mjs --selftest   # 24 checks, exit 0
```

The file is `tests/router-probe.mjs`, deliberately not `*.test.mjs`, so
`npm test` never runs it and it never spends router credits on a test run.

The raw rows were never committed, and no evidence file is shipped with this
doc: `.superpowers/` is gitignored (`.gitignore:15`), so the sweep output does
not exist in a fresh clone, and it stays out of a public repo because even
redacted router output carries per-account detail with no reason to be public.
The tables above are a complete transcription of that output for every id and
every phase, and the command in this section regenerates the rows.
