# Antigravity ("ag") OAuth token + refresh notes

Ground truth: 9router bundle `C:\npm-global\node_modules\9router\app\.next-cli-build\server\chunks\458.js`
(provider catalog entry `id:"antigravity"`) and `chunks\827.js` (the Google OAuth
refresher: the `if("gemini-cli"===b||"antigravity"===b)` branch). Local DB:
`providerConnections` table, `provider = 'antigravity'`, `authType = 'oauth'`.
(Reviewed 2026-10-11: an earlier draft cited `function q` in `chunks\3943.js` module
`8521`; that chunk holds the *generic* refresher `m()` for claude/iflow/github/kimi and
the codex-specific refresher, not the Google one. The Google path used by antigravity
lives in `827.js`.)

## 1. Endpoints and client

| Item | Value |
| --- | --- |
| Token endpoint | `https://oauth2.googleapis.com/token` |
| Client id | `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com` |
| Client secret | present in the catalog transport block (public embedded app config, same bundle; extractor does not copy it into `router-config.json`) |
| Chat/search API host | `https://daily-cloudcode-pa.googleapis.com` (`v1internal:generateContent`, `v1internal:streamGenerateContent`) |
| loadCodeAssist | `https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` |
| Authorize URL (reference only; worker never runs the browser flow) | `https://accounts.google.com/o/oauth2/v2/auth` |
| Refresh lead | `refreshLeadMs: 3e5` (5 minutes) in the catalog oauth block |

Catalog oauth scopes (only relevant to a fresh consent flow, not to refresh):
`https://www.googleapis.com/auth/cloud-platform`,
`.../userinfo.email`, `.../userinfo.profile`, `.../cclog`, `.../experimentsandconfigs`.

The worker needs only the client **id** to refresh. 9router's Google refresher for
antigravity (`827.js`, the shared `gemini-cli`/`antigravity` branch) posts all four
fields, so that exact shape is what we mirror.

## 2. Exact refresh request

```
POST https://oauth2.googleapis.com/token
Content-Type: application/x-www-form-urlencoded
Accept: application/json

grant_type=refresh_token
&refresh_token=<row.refreshToken>
&client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com
&client_secret=<catalog clientSecret>
```

Notes:

- Form-encoded body (`URLSearchParams`), never JSON. Google's token endpoint rejects
  `application/json` bodies for this grant.
- `client_secret` is included by 9router (the Google branch in `827.js` always sends it
  in the `URLSearchParams`). It is embedded in the
  public CLI bundle, so carrying it is the same exposure as the client id. If we later
  decide to keep the worker config secret-free, send the request without
  `client_secret` first: Google installed-app clients usually refresh fine with only
  `client_id`, and only the secret-less variant failing is a reason to add it.
- No `scope` on refresh (9router does not send one); the original grant's scopes are
  retained server-side.
- Success body: `{access_token, expires_in, scope, token_type, ...}`. Google returns a
  new `refresh_token` only for some grants: **if `refresh_token` is absent, keep the
  existing one** (9router does `refreshToken: e.refresh_token || c`).
- Failure body: `{error, error_description}`. Treat `invalid_grant` (refresh token
  revoked/expired/reused) as **permanent** for that connection: stop retrying it and fall
  through to the next `priority`. Attribution note (verified 2026-10-11): the Google
  branch in `827.js` has no permanent-error classification of its own, it just returns
  `null` on any non-ok status. The explicit permanent family
  (`refresh_token_expired`, `refresh_token_reused`, `refresh_token_invalidated`,
  `invalid_grant` -> `unrecoverable_refresh_error`) is codex's branch in `3943.js`.
  Adopting the same classification for antigravity is our policy choice (Google treats
  `invalid_grant` as terminal), not a behavior copied from the Google path.

Workers runtime: plain `fetch` + `URLSearchParams`, no Node APIs.

## 3. Expiry handling policy (worker)

Config rows carry `expiresAt` as an ISO-8601 UTC string (`2026-10-11T21:02:48.054Z`).

Refresh when:

```
expiresAt missing/invalid  OR  Date.parse(expiresAt) < Date.now() + 5 * 60_000
```

i.e. refresh 5 minutes before expiry, matching 9router's `refreshLeadMs = 3e5` (its
`Og` helper: `expiresAt - now < 3e5`).

Behaviour:

1. **Lazy refresh**: check only when a request is about to be sent on that connection,
   not on a timer. Cloudflare Workers have no durable timers; a cron trigger would be
   optional extra, not required.
2. **On-demand refresh for past-due rows**: current extract shows 2 of 11 rows already
   past `expiresAt`, so a refresh must be allowed *before first use*, not only as a
   pre-emptive skew.
3. **Single-flight per connection**: dedupe concurrent refreshes for the same
   `projectId`+`priority` inside the isolate (in-flight promise map), plus a ~10 s
   "recently refreshed" cache, mirroring 9router's `h()` wrapper. KV is eventually
   consistent across POPs, so duplicate refreshes across isolates are still possible;
   that is harmless (Google accepts repeated refreshes with the same token) as long as
   the returned `refresh_token` (if any) wins.
4. **Write-back**: persist `{accessToken, refreshToken, expiresAt, lastRefreshAt}` after
   every successful refresh so the next isolate does not redo it; skip write-back on
   failure so a transient error never clobbers a good refresh token.
5. **Failure**: on `401`/`403` from the token endpoint, or on a permanent `error`, mark
   the connection bad for this config generation and try the next candidate in
   `priority` order (the existing `RETRY_STATUSES` rotation already walks candidates).
   On network error, keep the old token and proceed; the API call will fail with 401 and
   re-enter rotation.
6. **Never log tokens.** Errors may carry `error`, `error_description`, HTTP status and
   the connection label/projectId only.

## 4. KV key layout

Binding: `ROUTER_CONFIG` (already used by `loadConfig()`).

| Key | Writer | Contents | Mutability |
| --- | --- | --- | --- |
| `router:config` | `extract-config.py` (manual push) | v1 static config: `authKeys`, `providers`, `connections`, `combos`, `aliases`, `aliasProviders`, plus `antigravity: [{projectId, accessToken, refreshToken, expiresAt, clientId, priority, label}]` (11 rows, active oauth rows only) | Replaced wholesale on each extract |
| `router:ag-tokens` (v2, not yet written by worker) | worker | Refresh overlay: `{"<priority>": {projectId, accessToken, refreshToken, expiresAt, lastRefreshAt}}` | Written only by the worker after a successful refresh |

Rules:

- Extract never deletes keys it does not know about, so pushing a fresh
  `router:config` leaves `router:ag-tokens` intact; the worker merges the overlay over
  `config.antigravity` (match on `priority`, which is stable per row) and prefers the
  overlay's `accessToken`/`expiresAt`/`refreshToken` when it is newer.
- 60 s in-memory config cache (`CACHE_MS`) means a refreshed token becomes visible to a
  given isolate at the next reload; keep the refreshed token in a separate
  isolate-local map keyed by `priority` so the in-flight request uses it immediately.
- Both keys hold bearer credentials: same handling as today (`router-config.json` is
  gitignored, pushed to KV only). Do not echo either key in `/health`.

## 5. Extractor contract

`extract-config.py` emits `config.antigravity` with exactly these fields per row:

`projectId` (empty string when the row has none, 4 of 11 today), `accessToken`,
`refreshToken`, `expiresAt`, `clientId` (from the catalog block, single distinct value),
`priority` (1..11, ascending), `label` (the connection's `name`, i.e. the account email).

A row is emitted when it has an access **or** a refresh token, so `accessToken` may be
an empty string (refresh-only row). The worker must treat empty/missing `accessToken`
or `expiresAt` as "needs refresh", which is what section 3's rule already says. As of
the 2026-10-11 extract all 11 rows carry both tokens.

Implementation status (reviewed 2026-10-11/12): the worker side of this document is
still unimplemented. `src/index.ts` only declares the `AntigravityRow` type; there is
no `src/antigravity.ts`, no refresh call, no `router:ag-tokens` overlay merge, no
`ag`/`websearch:antigravity` routing, and no SSE thought-signature translation.
Section 3 and 4 are the contract the implementing task must follow.

Only `provider = 'antigravity' AND authType = 'oauth' AND isActive = 1` rows are
emitted; qoder/kiro/cursor/xai oauth rows are deliberately ignored. The summary line
printed by the extractor contains counts only, never token values.

The catalog entry `providers.antigravity` is intentionally absent from the config: its
transport uses the array form `baseUrls:[...]` (resolved base
`https://daily-cloudcode-pa.googleapis.com`, module 74129 `w3` in `458.js`) plus
`format:"antigravity"`, so there is no OpenAI-compatible chat `baseUrl` to copy. The
chat forwarder for `ag` must build `POST {apiEndpoint}/v1internal:generateContent`
(`apiVersion: "v1internal"`, `loadCodeAssistEndpoint` as in section 1) itself; see
section 1. The extractor also scopes each provider's catalog fields to the window
between its own `id:"..."` match and the next provider's, so a neighbouring provider's
transport or media config can no longer leak into an entry (antigravity previously
picked up `api.anthropic.com`).
