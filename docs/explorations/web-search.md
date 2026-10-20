# Web search via Parallel — architecture exploration (READ-ONLY)

BLIP personal agent. Repo (PUBLIC GitHub `ZayFE7/agent-federation`). Cloudflare Workers + Durable
Objects. This report analyses only the **web search** path (`web_search` tool + the deterministic
`search:` prefix) and its provider, Parallel (parallel.ai). No source files were modified. Env
**values** are never written here — names only.

> Note on citations: `README.md:14-22` lists line numbers that are now stale — `src/agent.ts` is
> 1021 lines, not 521. All file:line refs below are re-verified against the current tree.

## Scope

- The single network helper `webSearch()` — `src/agent.ts:425-461`.
- The result formatter `formatSearchResults()` (pure, exported for unit tests) — `src/agent.ts:108-133`,
  and the `SearchResult`/`clip()` primitives — `src/agent.ts:89-99`.
- The `web_search` tool schema offered to the model — `src/agent.ts:614-636`.
- The tool dispatch inside the model loop — `src/agent.ts:841-847`.
- The deterministic direct path for `search: <query>` — `src/agent.ts:87`, `552-567`.
- Config/env wiring: optional `PARALLEL_API_KEY` (`src/types.ts` `Env`, `wrangler.jsonc:45`).
- Capability copy that promises search — `src/agent.ts:58`, `575-577`, `587`.
- Provider research: Parallel Web Search official docs (request/response/params/pricing) + a short
  comparison vs Brave / Tavily / Exa / Perplexity Sonar.
- Out of scope (other domains): the router/model layer, sandbox, memory, UI mascot.

## Current behavior (file:line, exact params sent)

### Request BLIP actually sends to Parallel
`src/agent.ts:438-447`:

- Endpoint: `POST https://api.parallel.ai/v1/search` — **correct, current** version (not the older
  `/v1beta`). Confirmed against `docs.parallel.ai/api-reference/search`.
- Auth header: `x-api-key: this.env.PARALLEL_API_KEY` (`:443`). Key is **optional**
  (`src/types.ts` `Env`); when unset the helper short-circuits with a non-error text (`:430-432`).
- `content-type: application/json` (`:444`).
- Body (the whole payload): `{ objective: q, search_queries: [q] }` (`:444`) — i.e. the **same**
  trimmed string is used as both the natural-language objective and the single query string.
- Timeout: `AbortSignal.timeout(20_000)` = 20 s, "fail fast, don't hang the tool loop/UI" (`:446`).

What is **NOT** sent, although Parallel supports it: `max_results`, `mode`
(`fast`/`turbo`/`advanced`), `include_domains`/`exclude_domains`, excerpt sizing
(`max_chars_total`/`max_chars_per_result`), recency/date filters and `score_threshold`. Because
`max_results` is omitted, Parallel returns its **default of 10** results; because `mode` is omitted,
it runs the **default `advanced`** mode (the slowest/most expensive lane).

### Response mapping into the text the model reads
`src/agent.ts:448-457`:
- Non-2xx: reads body, `.slice(0, 300)` (`:449`), returns
  `"web search failed (HTTP <status>): <errText>. The Parallel key may lack the Search product; tell
  the user."` with `ok:false` (`:450-453`). (Parallel keys are product-scoped, so a Search-unentitled
  key surfaces here as 401/403.)
- 2xx: parsed as `{ results?: SearchResult[] }` (`:455`); `results = sd.results || []`. **Only three
  fields are ever read** — `url`, `title`, `excerpts` (`SearchResult`, `:94-99`). Parallel also returns
  `publish_date` per result, and top-level `search_id`, `warnings`, `usage`, `session_id`
  (`docs.parallel.ai/api-reference/search`); **all are dropped**.
- `return { out: formatSearchResults(q, results, cap), ok: results.length > 0 }` (`:457`).

### Excerpt / count caps (the `.slice` / `.clip` caps)
`src/agent.ts:436` computes `cap = Math.min(10, Math.max(1, Math.floor(maxResults) || 5))` and passes
it as the 3rd arg to the formatter, which recomputes the identical expression (`:116`):
- Result-count cap: `results.slice(0, cap)` (`:117`) — client-side slice of whatever Parallel returned.
- Per-result excerpt cap: each result's `excerpts` array is joined with a space, whitespace-collapsed,
  then `clip(..., 400)` → **400 characters** with a ` [truncated N chars]` suffix (`:121`, `clip` at `:89-92`).
- Tool-card cap: the dispatch stores `output: r.out.slice(0, 4000)` for the UI (`:872`); the direct
  path likewise `.slice(0, 4000)` (`:558`).
- Re-summary cap in self-critique: tool outputs are re-clipped to 600 chars (`:968-969`).

### Citations / URL preservation
`src/agent.ts:118-124`: each shown result is rendered as
`<n>. <title>\n   <url>\n   <excerpt>`, falling back to `r.url`/`(no url)`/`(no excerpt)`. Titles and
raw URLs **are preserved** in the text the model reads, so it can cite them. There is **no structured
source list** (no ids, no `publish_date`, no per-source token accounting) handed to the model or UI.

### Truncation signalling
Partial. `formatSearchResults` (`:125-131`) emits a header `Found N web result(s)…(showing top K)` and
a tail `[Showing K of N. Raise max_results (up to 10) or narrow the query for more.]`, and `clip()`
marks character truncation. **But** the "Raise max_results" hint is misleading: `max_results` is never
sent to Parallel, so raising it only changes the client slice — and Parallel's default already returns
10, the same ceiling the hint implies.

### Error handling / timeouts / auth summary
- Never throws: all failure modes return `{out, ok:false}` text (`:430-460`).
- 20 s hard timeout, no retry, no backoff, no special handling for 429/5xx (`:446`, `:448-453`).
- Auth is header-only (`x-api-key`); a missing key degrades to a config message, not a crash (`:430-432`).

### Two entry points
1. Model tool: `web_search(query, max_results?)` — `src/agent.ts:614-636`; dispatch at `:841-847` calls
   `this.webSearch(query, args.max_results ?? 5)`. The tool loop runs up to **4 rounds** (`:715`), so a
   chatty model can issue up to 4 sequential 20 s searches per turn.
2. Deterministic direct path: `search: <query>` (`DIRECT_SEARCH_RE`, `:87`; handler `:552-567`) calls
   `this.webSearch(query, 5)` with **max_results hardcoded to 5** (`:555`), bypassing the model.
   Note the regex is `/^search\s*[:\s]\s*(.+)$/is` (`:87`) — anchored, case-insensitive, single-line.

## Problems & risks

- **[Critical] Metered provider presented as free.** `README.md:3` claims BLIP is "built entirely on
  free, no-card tiers", and the capability copy (`src/agent.ts:58`, `575-577`) advertises search with no
  cost caveat — but Parallel Search is **~$1–5 per 1,000 requests with no documented free tier**
  (`docs.parallel.ai/pricing`). Every model-initiated search and every `search:` prefix is billable.
  Budget/positioning mismatch and an honesty gap in the product copy.
- **[Major] Over-fetching: pays for 10, shows 5.** `max_results` is never sent (`:444`), so Parallel
  returns its default 10 and the client slices to 5 (`:116-117`). Pure waste of billed results on the
  default path.
- **[Major] Defaulting to the most expensive/slow `mode`.** No `mode` sent → `advanced`. For a
  free-tier, latency-sensitive chat agent this is the wrong default; the tool gives the model no way to
  ask for `fast`/`turbo`.
- **[Major] No recency, domain, or category controls.** Tool schema (`:620-632`) exposes only
  `query`/`max_results`. No `include/exclude_domains`, no date window, no `score_threshold`. Real
  research (news, prices, docs for "2026") needs recency + domain scoping that BLIP cannot express.
- **[Major] No caching / dedup.** Identical or repeated queries re-bill every call. Nothing caches by
  query+params (memory tables in `src/memory.ts` are unrelated). A busy session or a daily recurring job
  that searches the same thing pays repeatedly.
- **[Major] Single-shot, no decomposition.** `objective` and the only `search_queries[0]` are the same
  string (`:444`). Parallel natively accepts multiple queries per request and has a deep
  research/generate lane; BLIP uses neither, so multi-part research questions get one thin answer.
- **[Minor] Recency signal dropped.** `publish_date` returned by Parallel is ignored
  (`SearchResult`, `:94-99`), so the model cannot judge source freshness when citing.
- **[Minor] Cost/health metrics dropped.** Top-level `usage` and `warnings` are never parsed (`:455`),
  so per-call cost is invisible and a degraded/partial search is indistinguishable from a clean one.
- **[Minor] Wasted excerpt bandwidth.** Parallel's `max_chars_per_result`/`max_chars_total` are not set;
  BLIP fetches full excerpts then `clip`s to 400 client-side (`:121`), discarding billed content.
- **[Minor] Misleading truncation hint.** "Raise max_results (up to 10)" implies more can be fetched,
  but the value never reaches Parallel (`:128-131`).
- **[Minor] Timeout arithmetic in the loop.** Up to 4 rounds × 20 s search (`:715`, `:446`) can approach
  ~80 s of search wall-clock plus router round trips (25 s each, `:727`); no retry/backoff for transient
  429/5xx means one blip consumes a whole loop round.
- **[Minor] No unit test despite being test-designed.** `formatSearchResults` is explicitly exported as
  "pure… unit-testable without the network" (`:106-108`) but `tests/` (guardrails, live-matrix, markdown,
  memory) has no search test.

## Provider comparison (short table)

Public list pricing; verify against each provider's live pricing page before committing — Parallel/Brave
confirmed via docs and 2026 comparison articles, others approximate.

| Provider | Result quality for agents | Structured output | Citation support | Approx price (per ~1k) | Notes for BLIP |
|---|---|---|---|---|---|
| **Parallel (current)** | Strong; LLM-optimized "excerpts" from its own index | `results[]`: url, title, publish_date, excerpts; `usage`, `warnings` | Returns URLs + excerpts to quote | **$1–5 / 1k**, no free tier | Native multi-query + `mode`/`include_domains` unused by BLIP |
| **Brave Search API** | Good independent web index | Raw web results (title/url/description), no LLM excerpt | URLs only; model must fetch to cite | **~$5 / 1k**, **free tier ~2k/mo** | Cheapest path to "free tier" claim; needs a page-read step for context |
| **Tavily** | Tuned for RAG/agents; returns content snippets | Structured results + answer + scores | URLs + snippets, cite-friendly | **1k credits/mo free**, then tiered | Good free-tier fit; excerpt quality ~Parallel |
| **Exa** | Neural/semantic search, high relevance | Structured results + optional full content extract | URLs + contents; strong for "read page" | **~$7 / 1k** (varies) | Has built-in contents/answer endpoint — replaces a custom read tool |
| **Perplexity Sonar** | Answer synthesis + sources | Answer text + `citations[]` | **Best-in-class ready-to-cite sources** | **$5 / 1k search credit + tokens** | Returns a composed answer, not raw excerpts — different UX; token billing adds cost variance |

Takeaway: for a "free, no-card" positioning, **Brave** or **Tavily** free tiers are a better default
than Parallel; for citation UX, **Perplexity Sonar** returns ready-to-cite sources. Parallel is
competitive on excerpt quality but is paid-only and BLIP currently under-uses its parameters.

## Near-term improvements (small, low-risk, mostly within `webSearch()` `src/agent.ts:438-457`)

1. **Send `max_results` = the computed `cap`** to Parallel instead of relying on the default 10 + client
   slice — pay only for what you show (`:444`, `:116-117`).
2. **Set `mode`** (e.g. `fast` for the `cheap` tier / direct path, `advanced` only when the model asks) —
   cuts latency and cost on the hot path.
3. **Request excerpt ceilings via the API** (`max_chars_per_result`/`max_chars_total`) so full text isn't
   billed and then `clip`ped away (`:121`); keep `clip()` as a defensive second cap.
4. **Parse and surface `publish_date`, `usage`, `warnings`** — add freshness next to each URL, log cost,
   and degrade gracefully (append a note) when `warnings` is non-empty (`:455`, `:94-99`).
5. **Expose recency + domain filters** in the tool schema (`include_domains`, date window) and pass them
   through; confirm exact field names against the live `docs.parallel.ai/api-reference/search` before
   wiring.
6. **Fix the truncation hint** to reflect that `max_results` is now honored, and remove the misleading
   "up to 10" wording (`:128-131`).
7. **Honesty/cost copy:** update `README.md:3` and capability copy (`src/agent.ts:58`,`575-577`) to state
   search is metered, and add a per-day call budget guard in the worker.
8. **Add a unit test** for `formatSearchResults` (caps, empty results, truncation tail, missing
   url/excerpt fallbacks) — it is already exported for exactly this (`:106-108`).

## Next features

- **Filtered / domain-scoped search.** What: tool params `include_domains`, `exclude_domains`,
  `category`. Why: news/prices/docs queries need scoping; Parallel supports domains natively. Design:
  extend `web_search` schema (`:620-632`) → thread through `webSearch(query, max, opts)` body (`:444`).
  Effort: **S**. Risk: low (schema drift with provider; validate/whitelist domains).
- **Read-full-page companion tool.** What: `web_fetch(url)` returning cleaned markdown for a chosen URL.
  Why: excerpts are 400 chars — real research needs the source. Design: two options — (a) Parallel
  extract/generate lane (paid, high quality, one SDK-style call), or (b) free `SANDBOX` `curl` + HTML
  strip via `execSandbox` (`src/agent.ts:468-503`) reusing the existing sandbox. Effort: **M**. Risk: M
  (JS/login pages fail on curl; SSRF — must validate scheme/host, block internal ranges; token budget on
  page size).
- **Multi-query deep research.** What: decompose the ask into N sub-queries, fan out, merge/dedup. Why:
  single-shot `objective==query` (`:444`) gives thin answers to compound questions. Design: cheapest =
  pack multiple strings into one `search_queries[]` call (Parallel returns one merged `results[]`);
  fuller = an orchestrated loop that plans (reuse `plan` tool, `:666-682`), searches per step, merges by
  URL, then hands a de-duplicated source set to the answer model. Effort: **M (native multi-query) / L
  (orchestrated)**. Risk: cost + latency blow-up (bounded by the 4-round loop, `:715`); needs a result
  budget.
- **Result caching / dedup.** What: TTL cache keyed by `(query, mode, max_results, filters)`. Why:
  repeated/near-duplicate searches re-bill; recurring daily jobs search the same thing. Design: SQLite
  table in the DO (pattern like `memory.ts`), store rendered `out` + fetched_at, serve on hit within TTL;
  dedup results across queries by URL. Effort: **S–M**. Risk: staleness for news (short TTL), storing
  user queries (privacy), DO storage growth.
- **Recency controls.** What: explicit time-window / freshness knob surfaced to the model and in `search:`
  prefix. Why: current path ignores dates; `publish_date` discarded. Design: parse a
  `recency=day|week|month|year` tool arg → provider date params; show `publish_date` in output. Effort:
  **S**. Risk: low (provider support/field names unverified).
- **Ready-to-cite sources within token budget.** What: return a structured `sources[]` block (id, title,
  url, publish_date) with numbered inline citations, sized to a token budget, rendered as clickable cards
  in the UI. Why: today citations survive only as loose text (`:118-124`); the model can hallucinate or
  drop URLs. Design: extend the search return to carry both the prose `out` and a `sources` array
  (`ToolRun`/`AgentReply` in `src/types.ts:16-40`), budget by trimming excerpts first, keep a source
  ledger. Effort: **M**. Risk: touches the reply/UI envelope contract; ensure the self-critique pass
  (`:961-1020`) doesn't rewrite away citation ids.

## Open questions for the user

1. Which Parallel product/plan is `PARALLEL_API_KEY` entitled to (Search vs Agents), and is there a hard
   monthly spend ceiling? (Drives whether we default `mode=fast`, add a call budget, or switch provider.)
2. Is "free, no-card tiers" a **hard** constraint? If so, should we move search to Brave/Tavily free
   tiers and keep Parallel only as a premium fallback?
3. For multi-query deep research: prefer Parallel's native one-call `search_queries[]` (cheap, low
   latency) or an orchestrated plan→search→merge loop (better coverage, higher cost/latency)?
4. For read-full-page: use Parallel's extract/parse lane (paid, robust) or free sandbox `curl`+strip
   (free, but fails on JS/auth-gated pages)? Which SSRF/host policy is acceptable?
5. What `max_results` ceiling and excerpt length are acceptable per call for token budget and cost?
6. Caching: acceptable TTL for freshness vs cost savings, and is persisting raw search queries/results in
   the DO SQLite store okay from a privacy standpoint?
7. Do you want citations surfaced as clickable source cards in `ui/` (requires the structured
   `sources[]` envelope change)?
8. Confirm current Parallel parameter names/ranges directly against `docs.parallel.ai/api-reference/`
   (recency/date and `score_threshold` naming was not fully pinned during research).

---
Sources (public provider docs/articles consulted for this report):
- Parallel API reference — Search: https://docs.parallel.ai/api-reference/search
- Parallel Search quickstart: https://docs.parallel.ai/search/search-quickstart
- Parallel pricing: https://docs.parallel.ai/pricing
- "Best Search API for AI Apps" (Brave/Perplexity/Exa per-1k pricing): https://cloro.dev/blog/best-search-api/
- Brave Search API alternatives (Brave pricing): https://exa.ai/alternatives/brave-search-api
- Best web search API 2026 comparison: https://www.linkup.so/blog/best-web-search-api-in-2026-top-providers-compared
- Parallel vs alternatives roundup: https://www.therundown.ai/tools/parallelsearch
