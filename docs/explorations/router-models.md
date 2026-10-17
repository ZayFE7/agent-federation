# LLM Router (zay-router) + model/provider layer

Read-only exploration. No source file was modified; this is the only file written.
Secrets are referenced by env-var / KV-field **name** only (`ROUTER_KEY`, `ROUTER_URL`,
`AGENT_API_KEY`, `STATE_KEY`, `SBOX_TOKEN`, `PARALLEL_API_KEY`, `MODEL_PRIMARY`,
`MODEL_CHEAP`, KV `router:config` / `router:ag-tokens`). No provider API key, OAuth token,
KV id value, or bearer value is reproduced here. `deploy/router-worker/router-config.json`
is gitignored (`.gitignore:8`) and does **not** exist in the clone; its shape is described
from `src/index.ts:6-55` and the writer `extract-config.py:202-210` only.

---

## Scope

Covers the Cloudflare Worker deployed as `zay-router` (`deploy/router-worker/src/index.ts`,
507 lines) — the OpenAI-compatible front door that resolves a requested model string into a
ranked list of upstream connections and forwards with the right credential shape — and the
model/provider layer it depends on. It also cross-references how the brain actually calls it:
the chat/tool loop `src/agent.ts:715-745`, the self-critique call `src/agent.ts:967-1019`, the
mascot decider `src/index.ts:149-189`, the TEMP debug branch `src/index.ts:128-139`, and the
tier model names `src/agent.ts:412-417` + `src/types.ts:48-49`.

In scope: resolution order, prefix/provider conventions, openai-vs-anthropic request building,
the fetch/rotate loop and its retry policy, the SSE-collapse path, error/observability shape,
timeouts, CORS, `/health`, the single committed KV/config coupling, and the auth surface. The
530 durability gap gets its own section. Out of scope (owned by sibling reports): the brain DO
queue, guardrail policy, sandbox semantics, memory recall quality — see
`docs/explorations/{streaming,security-guardrails,prompts-memory,e2b-sandbox}.md`.

---

## Current behavior (file:line)

### Config load & cache
`loadConfig()` reads KV binding `ROUTER_CONFIG`, key `router:config`, as JSON with a 60 s
per-isolate cache (`src/index.ts:65-71`, `CACHE_MS=60_000` at `:63`). If the key is absent every
request throws `router config missing in KV` (`:68`). There is no seeding path in this repo: the
writer `extract-config.py` is old-PC-only (points at `E:/…/9router/db/data.sqlite` and a
9router Next.js chunk, `extract-config.py:18-20`) and must push to remote KV via `wrangler kv
put --remote`. `README.md:61-70` confirms nothing can be seeded until 9router returns; until then
`/health` 500s and all `/v1/*` 401. The `wrangler.jsonc:6-11` KV id `45aef8b6…` is an **old-account
resource** (name only; value is an identifier, not a secret).

### resolve() — candidate ordering (`src/index.ts:81-133`)
1. **Alias first** (`:82`): `cfg.aliases[model] || model` (aliases are harvested from 9router
   `modelAliases` kv scope, `extract-config.py:192-198`).
2. **Combo second** (`:85-91`): if `cfg.combos[m]` exists, recursively flattens each sub-model's
   candidates in combo order; returns if non-empty.
3. **Prefix third** (`:94-115`): splits on the **first** `/` only (`slash = m.indexOf("/")`,
   guarded `slash > 0` so a leading `/` is not a prefix). Three tiers of prefix match, each
   sorted by ascending `priority`:
   - node prefix: `c.prefix === pfx` (`:98-101`) — e.g. `kk/claude-opus-5`.
   - builtin provider id: `c.provider === pfx && c.type === "builtin"` (`:103-106`).
   - provider alias: `cfg.aliasProviders[pfx]` → matches `c.provider` (`:108-113`; only `oc`→`opencode`
   exists, `extract-config.py:190`).
   `upstreamModel` becomes everything after the first slash, so multi-slash ids survive
   (`cf/@cf/qwen/qwen3.8-27b` → pfx `cf`, rest `@cf/qwen/qwen3.8-27b`).
4. **Exact defaultModel** (`:118-121`): connections whose `defaultModel === m`.
5. **OpenRouter bare-name passthrough** (`:125-130`): only when `!m.includes("/")`.
6. Else `[]` → caller returns 404 with a helpful combo/prefix list (`:409-420`).

Every ordered list is `sort((a,b)=>a.priority-b.priority)` — lower number wins, and rotation
walks candidates in that order (`:423`).

### Tier → upstream mapping
`tierModel()` (`src/agent.ts:412-417`) returns `{tier, model}`: cheap→`MODEL_CHEAP ?? DEFAULT_MODEL_CHEAP`,
primary→`MODEL_PRIMARY ?? DEFAULT_MODEL_PRIMARY`. In the committed config both resolve to the
same string `cf/@cf/qwen/qwen3.8-27b` (`wrangler.jsonc:38-39`, `src/types.ts:48-49`) — so
**MODEL_CHEAP === MODEL_PRIMARY today**: the two "tiers" hit the identical upstream. The
differentiation is only the `X-Tier` header (`src/agent.ts:723`, `:987`; `src/index.ts:155`) and
the model string. **The router never reads `X-Tier`** (no reference anywhere in
`deploy/router-worker/src/index.ts`; corroborated by `docs/explorations/streaming.md:234`). So at
the edge twin the tier header is dead; only the alternate `pipedream/router.py:191-195` honors it.
The `.dev.vars.example:3-4` shows the intended shape once tiers diverge
(`meta/muse-spark-1.3` vs `meta/muse-spark-1.3-contributor`) — the `meta/` prefix then resolves
via resolve() step 3a.

### upstreamChatUrl + request building (`src/index.ts:135-159`, `178-199`)
- **builtin** (`:136-153`): use the connection's own URL if it already looks like an API path
  (`/chat/completions|messages|t2a|generateContent`, `:139`); else prefer
  `cfg.providers[provider].baseUrl`; else guard-rebuild `${origin}/v1/chat/completions` when the
  catalog stored a validate/models URL (`:144-151`).
- **non-builtin** (`:154-158`): trailing-slash-stripped; if base ends `/v1` → `/messages` (anthropic)
  or `/chat/completions` (openai); else append `/v1/…`.
- `kind` is chosen purely from the **client path**: `url.pathname.endsWith("/messages")` (
  `src/index.ts:404-406`). Header shape is chosen purely from **`conn.type`**: anthropic → `x-api-key`
  + `anthropic-version: 2023-06-01` (`:188-190`); everything else → `Authorization: Bearer` (`:191-192`);
  `noAuth` conns get no credential (`:186-187`). Incoming `authorization/x-api-key/api-key` from the
  client are always stripped before adding the provider's own (`:183`); hop-by-hop headers dropped
  (`DROP_REQ_HEADERS :175`, `DROP_RES_HEADERS :176`). `extraHeaders` (opencode fingerprint quartet,
  `extract-config.py:180-186`) are layered last (`:194-196`). `cloudflare-ai` rewrites the account
  path segment (`:271-276`); `opencode` gets a fresh `x-opencode-request` id (`:268-270`, `:249-256`).

**No wire-format translation exists.** A client that posts OpenAI `/v1/chat/completions` against an
`anthropic`-type connection gets an OpenAI-shaped body sent to `${base}/v1/chat/completions`
(`:158`) which is not a real Anthropic endpoint → upstream 404. Conversely an Anthropic
`/v1/messages` client against a `builtin` connection is excluded by the `conn.type !== "builtin"`
guard at `:425`, falls to the media/passthrough branch, and lands on `${origin}/v1/messages`
(`:436-444`) — also wrong for e.g. Gemini. Only kind-matched lanes actually work; today the brain
only ever calls `/v1/chat/completions`, so only `openai`+`builtin` lanes are exercised.

### The fetch / rotate loop (`src/index.ts:422-502`)
For each candidate in priority order: compute `target` (`:425-445`), rewrite `model` in the body
(`:451-467`, `forceStream` forces `stream:true` `:453`, opencode re-injects the tool fingerprint
`:454-466`), `forward()` once (`:478`). Decision at `:479`:
`if (res.ok || !RETRY_STATUSES.has(res.status)) return …`. So:
- Success **or a non-retryable status** (400/404/409/422…) → **returned verbatim** to the brain.
- A **retryable** status → falls through to the next candidate; on the **last** retryable
  candidate the loop ends and returns a synthetic **502** `all candidates failed` (`:500-502`).
- `RETRY_STATUSES = {401,402,403,408,429,500,502,503,504}` (`:61`) — auth, quota, timeouts and
  5xx are **all treated identically**. `Retry-After` is never read. **No backoff, no jitter,
  no same-candidate retry, no max-attempt cap** other than "number of candidates". `forward()`
  itself carries dead code (`:278-283`): the `RETRY_STATUSES` branch and `void kind;` both just
  `return res`; the retry decision is entirely in the caller.

**There is no timeout on the upstream fetch.** `forward()` does a bare `await fetch(url, …)` with
no `signal` (`:277`). Because the loop `await`s each candidate serially, a hung provider on
candidate 1 never rotates and never fails — it stalls the worker until Cloudflare's own request
limit. The brain guards its side with `AbortSignal.timeout(25_000)` (`src/agent.ts:727`) and
`20_000` for self-critique (`:998`), so the user sees a "Router timed out after 25s" reply
(`:733-739`), but the router keeps burning a subrequest and rotates nothing.

### Streaming internals
The only aggregation is `aggregateSSE()` (`src/index.ts:201-247`), invoked **only** on the
`forceStream && !clientWantedStream && event-stream` branch (`:480-485`) — i.e. the OpenCode free
lane. Everything else is pure passthrough (`:486-492`) or, for a client that asked
`stream:true`, the raw SSE body is forwarded untouched with `x-router-conn` and ACAO headers
(`:490-492`). There is no true streaming engine.

`aggregateSSE` collapses SSE into one `chat.completion`. **The prior reviewer's finding is
confirmed and is worse than "drops tool_calls/reasoning at 220/228/241":**
- The parsed chunk type (`:214-222`) declares `delta?: { content?, reasoning_content? }` and **no
  `tool_calls` at all** (`:220`) — so `delta.tool_calls` fragments are structurally unreadable and
  dropped.
- Only `ch.delta.content` is concatenated (`:228`); `reasoning_content` is in the type but **never
  read** — reasoning is dropped despite being modeled.
- Output `message` is `{ role, content }` only (`:241-242`) — no `tool_calls`, so a model that
  answered via tools collapses to empty text.
- `finish_reason` **is** preserved as a single scalar (`:206`,`:227`) — last non-empty wins;
  acceptable.
- **`usage` is hard-coded to zeros** (`:245`) — provider usage in a final chunk is discarded, so
  token accounting downstream is impossible on this path.
- **Mid-stream errors are not detected**: an error JSON chunk parses fine but has no `choices`, so
  it is silently skipped; a truncated/aborted stream returns a 200 with partial content and no
  signal that the stream broke.
- Only `choices[0]` is read (`:226`) — multi-candidate streams are ignored (minor).
- Cosmetic bug: `id` is initialized to `" aggregated"` with a leading space (`:207`) that is only
  trimmed when a chunk supplies an id (`:224`).

Net: `aggregateSSE` is safe only for plain-text answers. If it ever fronts a tool-capable lane,
the brain's `data.choices[0].message.tool_calls` read (`src/agent.ts:748`) sees `undefined` and the
loop breaks to a text reply (`:749-752`) — a silent capability loss, not a crash.

### Error shape, health, CORS, config coupling
- Auth failure → 401 `{error:{message,type:"auth_error"}}` (`:362-363`). Unroutable → 404
  `{error:{message,type:"model_not_found"}}` listing combos/prefixes (`:410-419`). All-failed → 502
  `{error:{message,type:"router_error"}}` with the truncated `lastErr` (`:494`,`:500-502`). Config
  load error → 500 `{error:{message}}` (no `type`) (`:370`). Passthrough errors keep the **raw
  upstream body** (unknown shape) (`:486-492`). The brain ignores all of it — `src/agent.ts:742-745`
  renders `Router returned ${status}.` only, so the useful `model_not_found` hint never reaches the
  user.
- **Observability is near zero.** No `console.log`/`wrangler tail`-able record of which candidate
  was chosen, per-attempt status, or latency. `x-router-conn` (`:483`,`:491`) is the only routing
  breadcrumb, and only on the success/aggregated paths — the 502 body carries `lastErr` but no
  attempt list.
- `/health` (`:300-312`) is unauthenticated, reports connection/combo counts and the prefix set,
  500s if config is missing (`:310`). No credential echo — good.
- CORS: preflight allows origin `*`, methods GET/POST/OPTIONS, and headers
  `authorization,content-type,x-api-key,anthropic-version` (`:290-298`). It does **not** list
  `X-Tier`, so a browser preflight of the brain's header set would fail — harmless for server-side
  Workers fetch, but it blocks any future direct browser→router call. Responses set ACAO `*`
  (`:482`,`:490`) with no `Access-Control-Allow-Headers` echo.

### Security
- **Auth is a timing-unsafe flat list check**: `authed = cfg.authKeys.includes(got)` (`:355`)
  after stripping `Bearer ` (`:354`). Not constant-time, and a single leaked `authKey` (the
  `ROUTER_KEY` the brain presents) grants access to **every** connection / every upstream API key —
  there is no per-provider or per-tier scoping. Same coarse-auth hazard class as the brain vault's
  single `STATE_KEY` guarding the whole router DB (`src/index.ts:196-198`, see
  `docs/explorations/security-guardrails.md` M5). All provider keys also live in **one** KV blob
  (`router:config`), so one KV read compromise exposes the entire set.
- **Unauthenticated debug proxy**: `POST /debug-oc` (`:314-348`) sits **before** the `/v1/` auth
  gate (`:350-359` only guards `/v1/`). Anyone can drive it to fire a real upstream request against
  the OpenCode connection and read `sentHeaders` + `bodyPreview`. It masks the bearer
  (`:339 "Bearer ***"`), so no key value leaks, but it is an open SSRF/probe surface and it burns
  the free lane on demand.
- `authKeys.includes(got)` on a missing header yields `got=""`; if the config ever contains an
  empty string in `authKeys`, an unauthenticated request would pass. No such guard exists.
- The `model_not_found` 404 (`:410-419`) reflects the model string and the full combo/prefix lists
  back to any authenticated caller — low risk, but it enumerates the routing surface.

---

## The 530 root cause + durability plan

**Root cause (transport, above the router's own error handling).** The brain posts chat to
`this.env.ROUTER_URL` via plain `fetch` (`src/agent.ts:718-728`). `ROUTER_URL` is a secret
(`wrangler.jsonc:46`) currently pointed at a **cloudflared quick tunnel** to a local `omniroute`
process, *not* at the durable edge twin `zay-router` on `*.workers.dev`. Quick-tunnel
(`trycloudflare.com`) hostnames are ephemeral: they are randomly assigned per launch and die on
restart. When the local PC or the tunnel restarts, the hostname no longer maps to a live tunnel,
and the Cloudflare edge answers **530** ("origin DNS/ tunnel not resolvable"). The request never
reaches the router Worker, so none of the `RETRY_STATUSES`/rotation/404/502 logic in
`deploy/router-worker/src/index.ts` runs — the brain simply gets `Router returned 530.`
(`src/agent.ts:744`). `530` is not even in `RETRY_STATUSES` (`:61`); it is a transport artifact,
not an upstream HTTP status.

**Why chat uses the URL and not the service binding.** A same-account binding `ROUTER` →
`zay-router` already exists (`wrangler.jsonc:12`, typed `src/types.ts:68`, used in the decider
`src/index.ts:168-170`). Chat was deliberately *not* cut over (see
`docs/explorations/streaming.md:40-44`), and there is a real reason: the edge twin is **unseeded**
(KV `router:config` missing → `/v1/*` 401, `/health` 500, `README.md:61-70`) and its **v2 OAuth
lanes were never implemented** (`refresh-notes.md:144-148`, `src/index.ts:31-44` declares
`AntigravityRow` but no `src/antigravity.ts`, no refresh, no overlay merge). The local `omniroute`
supplies those models; `zay-router` cannot yet. So the URL is a feature stopgap that became a
durability liability.

**Durability gap.** One static, ephemeral, secret URL with no health gate, no failover, no
hot-reload. On every tunnel restart the brain silently points at a dead hostname until a human
re-`wrangler secret put ROUTER_URL`, and the user sees a bare 530 with no explanation.

**Fixes (in rough order of value):**
- **Named tunnel / fixed hostname (primary).** Replace the quick tunnel with a Cloudflare Named
  Tunnel bound to a stable DNS record (e.g. `router.<zone>`), so the URL is constant across
  restarts. Removes the rotating-URL failure mode outright.
- **Config hot-reload of the origin.** Move `ROUTER_URL` (and an ordered candidate list) out of a
  single secret into a small KV/D1/DO record the brain reads per-isolate with a short TTL, so a new
  tunnel URL can be pushed without a redeploy and the brain can hold **multiple** origins.
- **Health probe + multi-origin failover.** Probe each origin's `/health`
  (pattern already exists at `src/index.ts:128-139`) and fall through on 530/522/timeout; only send
  chat to a live origin. Cache the last healthy origin per isolate.
- **Cut chat to the `ROUTER` service binding once the twin is seeded** — mirrors `src/index.ts:168`,
  avoids workers.dev fetch-challenges and public-tunnel buffering
  (cloudflared quick tunnels buffer GET SSE — `github.com/cloudflare/cloudflared/issues/1449`,
  cited in `docs/explorations/streaming.md:41,175`). Keep `ROUTER_URL` as a dev fallback. This is
  blocked on seeding `router:config` and (for parity) implementing the OAuth lanes or accepting
  fewer models at the edge.
- **Surface a helpful error, not a bare 530.** Map transport statuses in the brain
  (`src/agent.ts:742-745`): 530/522/timeout → "model router is offline / tunnel rotated; check
  omniroute" + record the failing origin in the memory log, instead of `Router returned 530.`.

---

## Near-term improvements

- **Fix `aggregateSSE` before any streaming/forceStream lane goes live** (`src/index.ts:201-247`):
  accumulate `delta.tool_calls` (with `index`/`id`/`function.name`/`arguments` merging), keep
  `reasoning_content`, carry `usage` from the final chunk, and detect mid-stream error chunks
  instead of 200-ing partial text.
- **Add an upstream fetch timeout** in `forward()` (`src/index.ts:277`) via `AbortSignal.timeout(...)`,
  and treat the abort as a retryable rotation trigger so a hung provider can't stall the loop.
- **Honor status fidelity when rotating**: preserve the last meaningful upstream status (esp. 429
  quota, 401 auth) instead of always collapsing to 502 (`:500`); read `Retry-After`.
- **Add jitter + bounded backoff + a max-attempt cap** to the rotate loop (`:422-499`) — currently
  zero-delay, no retry of a candidate, no cap beyond candidate count.
- **Constant-time auth** (`:355`) with a length-guard against empty `authKeys`, and drop the
  unauthenticated `/debug-oc` proxy (`:314-348`) or move it behind the bearer gate.
- **Basic routing logs** (chosen conn, per-attempt status, latency, a request id) so 502/530
  incidents are debuggable from `wrangler tail`.
- **Add `X-Tier` to the CORS `allow-headers`** (`:295`) if any browser→router path is ever added,
  or stop sending it, since the router ignores it (`src/agent.ts:723` → no consumer).

---

## Next features (effort S/M/L)

- **Real streaming passthrough mode** — **M**: forward `stream:true` end-to-end (already mostly a
  passthrough at `:486-492`), but needs an SSE-aware tool/reasoning/usage accumulator only when
  collapsing is required, plus a streaming-capable transport (named tunnel or `ROUTER` binding —
  the quick tunnel buffers SSE). Ties directly to `docs/explorations/streaming.md`.
- **Retries with jitter + backoff + Retry-After** — **S**: wrap the rotate loop
  (`:422-499`) with per-attempt exponential backoff + jitter, a max attempt budget, and
  status-preserving fallthrough.
- **Per-provider health / circuit breaker** — **M**: track consecutive failures per `provider`/
  `prefix` in an isolate-local (or Durable Object) map, open a circuit for N s, skip broken lanes
  in `resolve()` ordering so rotation starts from known-good candidates.
- **Request/response metrics** — **S**: emit structured logs (latency, status, tokens, conn) and a
  `/metrics` or Analytics Engine publisher; no current instrumentation exists.
- **Config out of the committed file (KV/DO)** — **M**: today everything lives in one KV blob
  written by an old-PC script (`extract-config.py`, `src/index.ts:65-71`) with a KV id from a dead
  account (`wrangler.jsonc:9`). Move to a worker-owned config source (a DO-backed registry or a
  versioned KV key with an admin API + rotation), split provider keys into per-provider records,
  and give `router:ag-tokens` a real overlay writer (`refresh-notes.md §4`, `:110-130`).
- **Request-id tracing** — **S**: generate an id at the top of `fetch()` (`src/index.ts:287`), echo
  `x-request-id`, thread it through logs and the `x-router-conn` header so a brain→router→provider
  trail can be joined.

---

## Open questions for the user

1. Is `ROUTER_URL` still a cloudflared **quick tunnel**, and can we move to a **named tunnel / fixed
   hostname** or cut chat over to the `ROUTER` service binding? What is the actual current origin?
2. Do we seed `zay-router` KV (`router:config`) and re-mint a fresh KV namespace (the bound id is an
   old-account resource, `wrangler.jsonc:9`), or keep the brain pinned to local `omniroute` until
   the edge twin is fully wired?
3. Is the tier distinction real, or should it be removed? `MODEL_CHEAP === MODEL_PRIMARY`
   (`wrangler.jsonc:38-39`, `src/types.ts:48-49`) and the router ignores `X-Tier` entirely — do you
   want a cheap lane pointed at a genuinely cheaper model, or drop the header/masquerade?
4. The OpenCode free lane is a documented dead end (`README.md:70-71`) and the only consumer of the
   buggy `aggregateSSE` — should it be deleted (which removes the whole collapse path) or fixed?
5. Are Anthropic-format clients / `builtin` providers ever meant to interoperate (there is no
   openai↔anthropic wire translation, `src/index.ts:404-406` vs `:425`), or is openai-only the
   permanent contract for the brain?
6. Security appetite for `/debug-oc` (`src/index.ts:314-348`): remove it, gate it behind the bearer,
   or keep it as a live probe? And do you want per-provider auth scoping instead of one flat
   `authKeys` list?
7. Is `STATE_KEY`/`ROUTER_KEY` rotation expected after this report lands on a **public** repo
   (routes and field names are now documented)? `STATE_KEY` guards the whole router-DB vault
   (`src/index.ts:196-198`); `authKeys` guards all provider keys (`src/index.ts:355`).
