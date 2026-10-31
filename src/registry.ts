// The registry Durable Object: one instance (env.REGISTRY.idFromName("registry"))
// that owns the session index the console sidebar lists. It is pure bookkeeping
// over src/registry-store.ts; it never calls a model and never reads a transcript.
//
// This file is Worker-side: it value-imports `agents`, which pulls in
// `cloudflare:workers`, so no offline Node test can import it (the plan's D6
// limit, restated in progress.md R47). What it delegates to IS executed offline:
// the input parsing lives in src/registry-input.ts (tests/registry-input.test.mjs)
// and the SQL adapter in src/sql-handle.ts (tests/sql-handle.test.mjs).
// tests/registry.test.mjs reads this file as text and runs the seed statement
// named below against a real sqlite database.

import { Agent } from "agents";
import type { Env } from "./types";
import type { SqlHandle } from "./memory";
import { toSqlHandle, type SqlTag } from "./sql-handle";
import {
  MAX_LIMIT,
  idFromSegment,
  limitFrom,
  readJson,
  rowFrom,
} from "./registry-input";
import {
  PLACEHOLDER_TITLE,
  deleteSession,
  ensureRegistrySchema,
  getSession,
  listSessions,
  readRegistryMeta,
  renameSession,
  touchSession,
  upsertSession,
  writeRegistryMeta,
  type SessionRow,
} from "./registry-store";
import { MAIN_DO_NAME } from "./session-scope";
import {
  deleteProviderRow,
  ensureModelSchema,
  getProviderRow,
  listProviderRows,
  readModelDefault,
  upsertProviderRow,
  writeModelDefault,
  type ModelDefault,
  type ModelProvider,
} from "./model-store";
import { normalizeProviderId, type ProviderInput } from "./model-input";
import { decryptSecret, encryptSecret } from "./model-secrets";
import {
  countSkills,
  deleteSkillRow,
  ensureSkillSchema,
  getSkillRow,
  listSkillFileRows,
  listSkillRows,
  upsertSkillFiles,
  upsertSkillRow,
} from "./skill-store";
import type { SkillPackageFile } from "./types";
import type {
  GmailAccessResult,
  GoogleAccountRow,
  GoogleAccountView,
  GoogleOAuthStateRow,
  GoogleStatusView,
  GoogleTokens,
  GoogleUserInfo,
} from "./google-types";
import { GMAIL_SCOPE } from "./google-types";
import { GoogleStore, ensureGoogleSchema } from "./google-store";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  refreshGoogleToken,
  revokeGoogleToken,
} from "./google-oauth";

/**
 * Boot seed for the conversation that already exists.
 *
 * R55: a DIRECT statement with ON CONFLICT(id) DO NOTHING, never upsertSession.
 * upsertSession is a whole-row replace, so running it at boot would reset a
 * title the user renamed. Without this seed the registry-backed sidebar opens
 * empty and every conversation that already exists disappears from the list
 * (R43). The store's schema leaves workspace_ref NULL and defaults unread and
 * pinned to 0, which is exactly what a legacy session has today.
 *
 * DO NOTHING protects an EXISTING row, not an absent one, so on its own this
 * would re-insert `main` after the user deletes it and the sidebar would show a
 * "New session" whose DO still holds the real transcript (R64 I1). That is why
 * onStart() reads a persisted registry_meta marker first: the seed runs once per
 * database, and the marker outlives the DO instance that wrote it.
 */
const MAIN_SEED_STATEMENT =
  "INSERT INTO sessions (id, title, created_at, updated_at, pinned, unread) VALUES (?, ?, ?, ?, 0, 0) ON CONFLICT(id) DO NOTHING";

/** The registry_meta key holding the timestamp of the one boot seed (R64 I1). */
const SEEDED_KEY = "main_seeded";

/** The legacy session id, which is also the legacy DO name (R38: ids are bare). */
const LEGACY_SESSION_ID = MAIN_DO_NAME;

/** Length-check then constant-time string compare (no early exit on mismatch). */
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * True only when a non-empty AGENT_API_KEY is configured AND the request's
 * bearer token matches it. Fails CLOSED, the same rule as src/index.ts.
 *
 * Duplicated deliberately: Task 7 extracts this pair into src/auth.ts, which
 * does not exist yet, and a DO must not depend on the worker having checked for
 * it. When src/auth.ts lands, import from there instead of keeping two copies.
 */
function authed(request: Request, env: Env): boolean {
  const key = (env.AGENT_API_KEY ?? "").trim();
  if (!key) return false;
  const got = (request.headers.get("Authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  return safeEq(got, key);
}

const JSON_HEADERS = { "content-type": "application/json" };

function fail(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: JSON_HEADERS });
}

export class RegistryAgent extends Agent<Env> {
  private schemaReady = false;
  private readonly googleAccessCache = new Map<string, { token: string; expiresAt: number }>();

  /**
   * Adapt the Agents SDK's tagged-template this.sql(strings, ...values) into
   * the exec-style SqlHandle src/registry-store.ts takes. The adapter itself is
   * src/sql-handle.ts, shared with the `db()` in src/agent.ts; this method owns
   * only the schema guard.
   *
   * A reply carries `results` and nothing else, because the platform's cursor
   * exposes no per-statement affected-row count (R37, R58).
   */
  private db(): SqlHandle {
    const handle = toSqlHandle(this.sql.bind(this) as unknown as SqlTag);
    if (!this.schemaReady) {
      // The store owns every piece of DDL: the sessions table, registry_meta and
      // the composite index the sidebar's only query needs (R54). Nothing here
      // creates schema, so this guard and onStart() cannot disagree about it.
      ensureRegistrySchema(handle);
      ensureModelSchema(handle);
      ensureSkillSchema(handle);
      ensureGoogleSchema(handle);
      this.schemaReady = true;
    }
    return handle;
  }

  /**
   * Runs on every cold start, and seeds exactly once per database: the marker
   * read is what makes the second cold start after a delete of `main` a no-op
   * instead of a resurrection (R64 I1). Not this.setState: state saved here
   * would describe one instance, and a cold start is precisely what destroys it.
   *
   * Schema comes from `this.db()` and nothing else, so it is never created twice.
   */
  async onStart(): Promise<void> {
    const sql = this.db();
    if (readRegistryMeta(sql, SEEDED_KEY) !== null) return;
    const now = Date.now();
    sql.exec(MAIN_SEED_STATEMENT, LEGACY_SESSION_ID, PLACEHOLDER_TITLE, now, now);
    writeRegistryMeta(sql, SEEDED_KEY, String(Date.now()));
  }

  // ---- RPC surface (what src/routes.ts calls over the stub) ----

  /**
   * Newest first, pinned rows ahead. The limit is floored and capped here, so a
   * zero, a negative or a fraction can never reach SQLite as `LIMIT -1`, which
   * SQLite reads as unlimited.
   */
  async list(limit: number): Promise<SessionRow[]> {
    return listSessions(this.db(), Math.min(Math.max(1, Math.floor(limit)), MAX_LIMIT));
  }

  /**
   * One-row read for the worker's session routes (R74): is this id in the index?
   *
   * The routes must be able to refuse a well-formed id that no one created BEFORE
   * they address a session DO with it, because a DO name is an opaque string the
   * platform hashes to an id (R38): nothing about `idFromName` says "no such
   * session", so an uncreated id silently instantiates a DO, and its transcript
   * then lives in an instance that `GET /api/sessions` never lists (R73 amendment
   * 4). A DO name is not a path, so this is about orphan state and free DO
   * instantiation, never about traversal.
   *
   * `getSession` is the store's own one-row read, so no SQL is restated here, and
   * this is a real boolean rather than the affected-row count R58 forbids: it
   * reports a row, not a write.
   */
  async exists(id: string): Promise<boolean> {
    return getSession(this.db(), id) !== null;
  }

  /**
   * One-row read by id (Task 9): the title fiber's pre-rename check. It must
   * see the CURRENT title so a user rename that landed while the cheap model
   * was busy wins, and an absent row fails closed (no row, no rename). Not
   * `list(MAX_LIMIT)`: a row outside the 200 window would silently switch
   * title generation off for exactly the old sessions still saying
   * `New session`.
   *
   * `getSession` is the store's own one-row read, so no SQL is restated here.
   */
  async get(id: string): Promise<SessionRow | null> {
    return getSession(this.db(), id);
  }

  /** Whole-row write: the caller owns every column it sends, created_at included. */
  async put(row: SessionRow): Promise<void> {
    upsertSession(this.db(), row);
  }

  /** Title only; a rename deliberately does not bump updated_at. Returns void (R37, R58). */
  async rename(id: string, title: string): Promise<void> {
    renameSession(this.db(), id, title);
  }

  /** Returns void, never a "was it there" boolean (R37, R58). */
  async remove(id: string): Promise<void> {
    deleteSession(this.db(), id);
  }

  /** Bump updated_at to now, plus unread when opts carries an unreadDelta. */
  async touch(id: string, opts?: { unreadDelta?: number }): Promise<void> {
    touchSession(this.db(), id, Date.now(), opts);
  }

  private modelSecret(): string {
    return (this.env.AGENT_API_KEY ?? "").trim();
  }

  private async providerFromRow(row: {
    id: string;
    name: string;
    base_url: string;
    api_key_enc: string;
    models_json: string;
  }): Promise<ModelProvider> {
    let models: string[] = [];
    try {
      const parsed = JSON.parse(row.models_json);
      if (Array.isArray(parsed)) {
        models = parsed.filter((value): value is string => typeof value === "string");
      }
    } catch {
      models = [];
    }
    return {
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      apiKey: await decryptSecret(this.modelSecret(), row.api_key_enc),
      models,
    };
  }

  /** Full provider configs, including plaintext keys. Never send this to a browser. */
  async modelSettings(): Promise<{
    providers: ModelProvider[];
    default: ModelDefault | null;
  }> {
    const providers = await Promise.all(
      listProviderRows(this.db()).map((row) => this.providerFromRow(row))
    );
    return { providers, default: readModelDefault(this.db()) };
  }

  async saveModelProvider(
    id: string | null,
    input: ProviderInput
  ): Promise<ModelProvider | null> {
    const providerId =
      normalizeProviderId(id) ??
      `p_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const existing = getProviderRow(this.db(), providerId);
    let apiKeyEnc = existing?.api_key_enc ?? "";
    if (input.clearKey) apiKeyEnc = "";
    else if (input.apiKey) {
      try {
        apiKeyEnc = await encryptSecret(this.modelSecret(), input.apiKey);
      } catch {
        return null;
      }
    }
    const now = Date.now();
    upsertProviderRow(this.db(), {
      id: providerId,
      name: input.name,
      base_url: input.baseUrl,
      api_key_enc: apiKeyEnc,
      models_json: JSON.stringify(input.models),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });
    return {
      id: providerId,
      name: input.name,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey ?? (existing ? await decryptSecret(this.modelSecret(), existing.api_key_enc) : ""),
      models: input.models,
    };
  }

  async deleteModelProvider(id: string): Promise<boolean> {
    const providerId = normalizeProviderId(id);
    if (!providerId || !getProviderRow(this.db(), providerId)) return false;
    deleteProviderRow(this.db(), providerId);
    return true;
  }

  async modelDefault(): Promise<ModelDefault | null> {
    return readModelDefault(this.db());
  }

  async setModelDefault(provider: string, model: string): Promise<boolean> {
    const rawProvider = typeof provider === "string" ? provider.trim().toLowerCase() : "";
    const modelId = typeof model === "string" ? model.trim() : "";
    if (!modelId) return false;
    if (rawProvider === "deployment") {
      writeModelDefault(this.db(), { provider: "deployment", model: modelId });
      return true;
    }
    const providerId = normalizeProviderId(rawProvider);
    if (!providerId) return false;
    const row = getProviderRow(this.db(), providerId);
    if (!row) return false;
    let models: string[] = [];
    try {
      const parsed = JSON.parse(row.models_json);
      if (Array.isArray(parsed)) models = parsed.filter((v): v is string => typeof v === "string");
    } catch {
      return false;
    }
    if (!models.includes(modelId)) return false;
    writeModelDefault(this.db(), { provider: providerId, model: modelId });
    return true;
  }

  private googleStore(): GoogleStore {
    return new GoogleStore(this.db());
  }

  private googleClientId(): string {
    return (this.env.GOOGLE_CLIENT_ID ?? "").trim();
  }

  private googleClientSecret(): string {
    return (this.env.GOOGLE_CLIENT_SECRET ?? "").trim();
  }

  private googleRedirectUri(origin: string): string {
    const configured = (this.env.GOOGLE_REDIRECT_URI ?? "").trim();
    if (configured) return configured;
    return `${origin.replace(/\/+$/, "")}/api/connections/google/callback`;
  }

  async googleStatus(origin: string): Promise<GoogleStatusView> {
    const accounts = this.googleStore().listAccounts();
    const redirectUri = this.googleRedirectUri(origin);
    return {
      configured: Boolean(this.googleClientId() && this.googleClientSecret()),
      redirectUri,
      accounts: accounts.filter((row) => row.status === "active").length,
      defaultEmail: accounts.find((row) => row.is_default === 1)?.email ?? null,
    };
  }

  async googleBegin(
    origin: string,
    loginHint?: string
  ): Promise<{ ok: boolean; authUrl?: string; redirectUri: string; error?: string }> {
    const redirectUri = this.googleRedirectUri(origin);
    const clientId = this.googleClientId();
    if (!clientId || !this.googleClientSecret()) {
      return { ok: false, redirectUri, error: "google_not_configured" };
    }
    const now = Date.now();
    const store = this.googleStore();
    store.pruneStates(now, 10 * 60 * 1000);
    const state = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const stateRow: GoogleOAuthStateRow = {
      state,
      redirect_uri: redirectUri,
      login_hint: loginHint?.trim() || null,
      created_at: now,
    };
    store.createState(stateRow);
    return {
      ok: true,
      redirectUri,
      authUrl: buildGoogleAuthUrl({
        clientId,
        redirectUri,
        state,
        ...(loginHint ? { loginHint } : {}),
      }),
    };
  }

  async googleComplete(
    code: string,
    state: string
  ): Promise<{ ok: boolean; account?: GoogleAccountView; error?: string }> {
    const store = this.googleStore();
    const stateRow = store.consumeState(state, Date.now(), 10 * 60 * 1000);
    if (!stateRow) return { ok: false, error: "state_expired" };
    const clientId = this.googleClientId();
    const clientSecret = this.googleClientSecret();
    if (!clientId || !clientSecret) return { ok: false, error: "google_not_configured" };

    let tokens: GoogleTokens;
    let user: GoogleUserInfo;
    try {
      tokens = await exchangeGoogleCode(
        {
          clientId,
          clientSecret,
          code,
          redirectUri: stateRow.redirect_uri,
        },
        fetch
      );
      user = await fetchGoogleUserInfo(tokens.accessToken, fetch);
    } catch (err) {
      return { ok: false, error: String(err).slice(0, 300) };
    }

    const existing = store
      .listAccounts()
      .find((row) => row.google_sub === user.sub || row.email.toLowerCase() === user.email.toLowerCase());
    const encryptedRefresh = tokens.refreshToken
      ? await encryptSecret(this.modelSecret(), tokens.refreshToken)
      : existing?.refresh_enc;
    if (!encryptedRefresh) {
      return { ok: false, error: "Google did not return a refresh token; reconnect and grant offline access." };
    }
    const now = Date.now();
    const id = existing?.id ?? `ga_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const row: GoogleAccountRow = {
      id,
      google_sub: user.sub,
      email: user.email,
      name: user.name?.trim() || null,
      picture: user.picture?.trim() || null,
      refresh_enc: encryptedRefresh,
      scopes: (tokens.scopes.length ? tokens.scopes : [GMAIL_SCOPE]).join(" "),
      is_default: existing?.is_default ?? 0,
      status: "active",
      last_error: null,
      last_refresh_at: now,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    store.upsertAccount(row);
    if (!store.listAccounts().some((account) => account.is_default === 1)) {
      store.setDefault(id);
    }
    this.googleAccessCache.delete(id);
    const saved = store.getAccount(id);
    return saved
      ? { ok: true, account: store.publicAccount(saved) }
      : { ok: false, error: "the account could not be saved" };
  }

  async googleAccounts(): Promise<GoogleAccountView[]> {
    return this.googleStore().listAccounts().map((row) => this.googleStore().publicAccount(row));
  }

  async googleSetDefault(id: string): Promise<boolean> {
    const store = this.googleStore();
    if (!store.getAccount(id)) return false;
    store.setDefault(id);
    return true;
  }

  async googleDelete(id: string): Promise<boolean> {
    const store = this.googleStore();
    const row = store.getAccount(id);
    if (!row) return false;
    try {
      const refresh = await decryptSecret(this.modelSecret(), row.refresh_enc);
      if (refresh) await revokeGoogleToken(refresh, fetch);
    } catch {
      // A failed revoke must not strand a row the owner asked to remove.
    }
    store.deleteAccount(id);
    this.googleAccessCache.delete(id);
    return true;
  }

  async gmailAccess(account: string): Promise<GmailAccessResult> {
    const store = this.googleStore();
    const row = store.resolveAccount(account);
    if (!row) return { ok: false, error: "No connected Gmail account matches that id or email.", reauth: false };
    if (row.status === "reauth_required") {
      return {
        ok: false,
        error: `${row.email} needs to be reconnected in Connections.`,
        reauth: true,
      };
    }
    const now = Date.now();
    const cached = this.googleAccessCache.get(row.id);
    if (cached && cached.expiresAt - now > 60_000) {
      return {
        ok: true,
        access: { account: store.publicAccount(row), accessToken: cached.token },
      };
    }
    const clientId = this.googleClientId();
    const clientSecret = this.googleClientSecret();
    if (!clientId || !clientSecret) {
      return { ok: false, error: "Google OAuth is not configured.", reauth: false };
    }
    try {
      const refresh = await decryptSecret(this.modelSecret(), row.refresh_enc);
      if (!refresh) {
        store.markStatus(row.id, "reauth_required", "The stored Google token is unreadable.", now);
        return { ok: false, error: `${row.email} needs to be reconnected.`, reauth: true };
      }
      const tokens = await refreshGoogleToken(
        { clientId, clientSecret, refreshToken: refresh },
        fetch
      );
      this.googleAccessCache.set(row.id, {
        token: tokens.accessToken,
        expiresAt: now + Math.max(60, tokens.expiresIn) * 1000,
      });
      store.updateRefresh(row.id, row.refresh_enc, tokens.scopes.join(" "), now);
      return {
        ok: true,
        access: {
          account: store.publicAccount(store.getAccount(row.id) ?? row),
          accessToken: tokens.accessToken,
        },
      };
    } catch (err) {
      const message = String(err).slice(0, 300);
      const reauth = /invalid_grant|reauth|expired/i.test(message);
      if (reauth) store.markStatus(row.id, "reauth_required", message, now);
      return { ok: false, error: message, reauth };
    }
  }

  async skillCatalog(): Promise<Array<{ name: string; description: string; fileCount: number; source: string }>> {
    return listSkillRows(this.db()).map((row) => ({
      name: row.name,
      description: row.description,
      fileCount: row.file_count,
      source: row.source,
    }));
  }

  async skillGet(
    name: string
  ): Promise<{
    name: string;
    description: string;
    body: string;
    source: string;
    files: Array<{ path: string; bytes: number }>;
  } | null> {
    if (typeof name !== "string" || !name) return null;
    const row = getSkillRow(this.db(), name);
    if (!row) return null;
    const files = listSkillFileRows(this.db(), row.id).map((file) => ({
      path: file.path,
      bytes: file.bytes,
    }));
    return {
      name: row.name,
      description: row.description,
      body: row.body,
      source: row.source,
      files,
    };
  }

  async skillFiles(name: string): Promise<SkillPackageFile[] | null> {
    if (typeof name !== "string" || !name) return null;
    const row = getSkillRow(this.db(), name);
    if (!row) return null;
    return listSkillFileRows(this.db(), row.id).map((file) => ({
      path: file.path,
      bytes: file.bytes,
      contentBase64: file.content_b64,
    }));
  }

  async skillSave(
    name: string,
    description: string,
    body: string,
    files: SkillPackageFile[],
    source: string
  ): Promise<boolean> {
    if (typeof name !== "string" || !name || typeof description !== "string" || !body) return false;
    if (!getSkillRow(this.db(), name) && countSkills(this.db()) >= 100) return false;
    if (files.length > 500) return false;
    let total = 0;
    for (const file of files) {
      if (!file || typeof file.path !== "string" || !file.path) return false;
      if (!Number.isFinite(file.bytes) || file.bytes < 0 || file.bytes > 2 * 1024 * 1024) return false;
      if (typeof file.contentBase64 !== "string") return false;
      total += file.bytes;
      if (total > 8 * 1024 * 1024) return false;
    }
    const existing = getSkillRow(this.db(), name);
    const now = Date.now();
    upsertSkillRow(this.db(), {
      id: name,
      name,
      description,
      body,
      source: typeof source === "string" ? source.slice(0, 300) : "",
      file_count: files.length,
      bytes: total,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });
    upsertSkillFiles(this.db(), name, files);
    return true;
  }

  async skillDelete(name: string): Promise<boolean> {
    return deleteSkillRow(this.db(), name);
  }


  /**
   * HTTP surface for the worker proxy, under /registry/... only.
   *
   *   GET    /registry/sessions?limit=N    { ok, sessions }
   *   POST   /registry/sessions            put(row)        -> { ok, session }
   *   PATCH  /registry/sessions/:id        rename(id,t)    -> { ok }
   *   DELETE /registry/sessions/:id        remove(id)      -> { ok }
   *   POST   /registry/sessions/:id/touch  touch(id,opts)  -> { ok }
   *
   * Anything outside the prefix falls through to super.fetch, NOT a 404:
   * overriding fetch on an Agent subclass replaces the SDK's own entry point,
   * which routes through this.lifecycle.fetch and serves RPC and the WebSocket
   * surface, so a hard stop here would shadow every SDK HTTP surface on the DO.
   *
   * A path this DO owns but cannot serve with the method used answers 405; 404
   * is reserved for a shape it does not recognise at all.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/registry/")) {
      return super.fetch(request);
    }
    if (!authed(request, this.env)) {
      return fail(401, "unauthorized");
    }

    const route = url.pathname.replace(/^\/registry\//, "");
    const segments = route.split("/");

    if (segments[0] === "sessions" && segments.length === 1) {
      if (request.method === "GET") {
        const sessions = await this.list(limitFrom(url.searchParams));
        return new Response(JSON.stringify({ ok: true, sessions }), { headers: JSON_HEADERS });
      }
      if (request.method === "POST") {
        const row = rowFrom(await readJson(request));
        if (!row) return fail(400, "a full session row is required");
        await this.put(row);
        return new Response(JSON.stringify({ ok: true, session: row }), { headers: JSON_HEADERS });
      }
      return fail(405, "method not allowed");
    }

    if (segments[0] === "sessions" && (segments.length === 2 || segments.length === 3)) {
      const id = idFromSegment(segments[1]);
      if (!id) return fail(400, "session id required");
      const sub = segments[2];

      if (sub === undefined) {
        if (request.method === "PATCH") {
          const body = (await readJson(request)) as { title?: unknown } | null;
          const title = typeof body?.title === "string" ? body.title.trim() : "";
          if (!title) return fail(400, "title required");
          await this.rename(id, title);
          return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
        }
        if (request.method === "DELETE") {
          await this.remove(id);
          return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
        }
        if (request.method === "GET") {
          // Read-back over HTTP so a client can confirm a write landed; the RPC
          // surface has no get because Task 7's routes list instead.
          const session = getSession(this.db(), id);
          if (!session) return fail(404, "not found");
          return new Response(JSON.stringify({ ok: true, session }), { headers: JSON_HEADERS });
        }
        return fail(405, "method not allowed");
      }

      if (sub === "touch" && segments.length === 3) {
        // /registry/sessions/:id/touch is this DO's own path, whatever the
        // method, so a wrong one is 405 rather than a fall-through to 404.
        if (request.method !== "POST") {
          return fail(405, "method not allowed");
        }
        const body = (await readJson(request)) as { unreadDelta?: unknown } | null;
        if (body === null) return fail(400, "invalid JSON body");
        // An absent key and an explicit null both mean "no delta"; the store
        // reads undefined that way. Any other value must be a whole number.
        const delta = body.unreadDelta === null ? undefined : body.unreadDelta;
        if (delta !== undefined && !(typeof delta === "number" && Number.isInteger(delta))) {
          return fail(400, "unreadDelta must be an integer when present");
        }
        await this.touch(id, { unreadDelta: delta as number | undefined });
        return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
      }
    }

    return fail(404, "not found");
  }
}
