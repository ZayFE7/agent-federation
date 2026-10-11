// zay-router: always-on edge router generated from the local 9router setup.
// Config lives in KV (written by extract-config.py via wrangler kv put).
// v1 scope: API-key providers, prefixes, combos, aliases, media path mapping,
// streaming passthrough, priority rotation with retry on auth/quota errors.

interface ProviderCfg {
  baseUrl: string;
  stt?: string;
  tts?: string;
  image?: string;
  embeddings?: string;
  imageToText?: string;
}

interface ConnectionCfg {
  provider: string;
  key: string;
  priority: number;
  type: "openai" | "anthropic" | "builtin";
  baseUrl: string;
  prefix?: string;
  defaultModel?: string;
  accountId?: string;
  label?: string;
  noAuth?: boolean;
  forceStream?: boolean;
  extraHeaders?: Record<string, string>;
}

interface Config {
  authKeys: string[];
  providers: Record<string, ProviderCfg>;
  connections: ConnectionCfg[];
  combos: Record<string, string[]>;
  aliases: Record<string, string>;
  aliasProviders?: Record<string, string>;
}

interface Env {
  ROUTER_CONFIG: KVNamespace;
}

const RETRY_STATUSES = new Set([401, 402, 403, 408, 429, 500, 502, 503, 504]);
let cached: { cfg: Config; at: number } | null = null;
const CACHE_MS = 60_000;

async function loadConfig(env: Env): Promise<Config> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.cfg;
  const raw = await env.ROUTER_CONFIG.get("router:config", "json");
  if (!raw) throw new Error("router config missing in KV");
  cached = { cfg: raw as Config, at: Date.now() };
  return cached.cfg;
}

function json(status: number, body: unknown, extra?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(extra || {}) },
  });
}

/** Resolve requested model into ordered candidates: [{conn, upstreamModel}]. */
function resolve(cfg: Config, model: string): Array<{ conn: ConnectionCfg; upstreamModel: string }> {
  let m = cfg.aliases[model] || model;

  // Combo: try each listed model in order (flattened recursively by callers via recursion)
  if (cfg.combos[m]) {
    const out: Array<{ conn: ConnectionCfg; upstreamModel: string }> = [];
    for (const sub of cfg.combos[m]) {
      out.push(...resolve(cfg, sub));
    }
    if (out.length) return out;
  }

  // Node prefix: "kk/claude-opus-5" -> connections with prefix "kk"
  const slash = m.indexOf("/");
  if (slash > 0) {
    const pfx = m.slice(0, slash);
    const rest = m.slice(slash + 1);
    const pfxConns = cfg.connections
      .filter((c) => c.prefix === pfx)
      .sort((a, b) => a.priority - b.priority);
    if (pfxConns.length) return pfxConns.map((conn) => ({ conn, upstreamModel: rest }));
    // Builtin provider id as prefix: "gemini/gemini-3.8-flash"
    const provConns = cfg.connections
      .filter((c) => c.provider === pfx && c.type === "builtin")
      .sort((a, b) => a.priority - b.priority);
    if (provConns.length) return provConns.map((conn) => ({ conn, upstreamModel: rest }));
    // Provider alias as prefix: "oc/mimo-v2.6-flash" -> opencode
    const aliasId = cfg.aliasProviders?.[pfx];
    if (aliasId) {
      const alConns = cfg.connections
        .filter((c) => c.provider === aliasId)
        .sort((a, b) => a.priority - b.priority);
      if (alConns.length) return alConns.map((conn) => ({ conn, upstreamModel: rest }));
    }
  }

  // Exact defaultModel match
  const def = cfg.connections
    .filter((c) => c.defaultModel === m)
    .sort((a, b) => a.priority - b.priority);
  if (def.length) return def.map((conn) => ({ conn, upstreamModel: m }));

  // OpenRouter passthrough for bare model names only (its models contain
  // slashes natively, but we never send prefix-miss strings there).
  if (!m.includes("/")) {
    const or = cfg.connections
      .filter((c) => c.provider === "openrouter")
      .sort((a, b) => a.priority - b.priority);
    if (or.length) return or.map((conn) => ({ conn, upstreamModel: m }));
  }

  return [];
}

function upstreamChatUrl(cfg: Config, conn: ConnectionCfg, kind: "openai" | "anthropic"): string {
  if (conn.type === "builtin") {
    const b = cfg.providers[conn.provider]?.baseUrl || `${conn.baseUrl}/v1/chat/completions`;
    // Guard: catalog sometimes stores a validate/models URL instead of chat.
    if (!/chat\/completions|messages|t2a|generateContent/.test(b)) {
      try {
        const u = new URL(b);
        return `${u.origin}/v1/chat/completions`;
      } catch {
        /* fall through */
      }
    }
    return b;
  }
  const base = conn.baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/v1")) {
    return kind === "anthropic" ? `${base}/messages` : `${base}/chat/completions`;
  }
  return kind === "anthropic" ? `${base}/v1/messages` : `${base}/v1/chat/completions`;
}

/** Media path mapping for builtin catalog providers. */
function mediaUrl(cfg: Config, conn: ConnectionCfg, path: string): string | null {
  if (conn.type !== "builtin") return null;
  const p = cfg.providers[conn.provider];
  if (!p) return null;
  if (path.includes("/audio/transcriptions") || path.includes("/audio/translations")) {
    return p.stt || null;
  }
  if (path.includes("/audio/speech")) return p.tts || null;
  if (path.includes("/images/")) return p.image || null;
  if (path.includes("/embeddings")) return p.embeddings || null;
  return null;
}

const DROP_REQ_HEADERS = new Set(["host", "content-length", "connection", "accept-encoding"]);
const DROP_RES_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

function buildHeaders(conn: ConnectionCfg, incoming: Headers, isJson: boolean): Headers {
  const h = new Headers();
  incoming.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (DROP_REQ_HEADERS.has(lk)) return;
    if (lk === "authorization" || lk === "x-api-key" || lk === "api-key") return;
    h.set(k, v);
  });
  if (conn.noAuth) {
    /* free/no-auth provider: no credential header */
  } else if (conn.type === "anthropic") {
    h.set("x-api-key", conn.key);
    if (!h.has("anthropic-version")) h.set("anthropic-version", "2023-06-01");
  } else {
    h.set("authorization", `Bearer ${conn.key}`);
  }
  if (conn.extraHeaders) {
    for (const [k, v] of Object.entries(conn.extraHeaders)) h.set(k, v);
  }
  if (isJson && !h.has("content-type")) h.set("content-type", "application/json");
  return h;
}

/** Collapse an SSE chat stream into a single chat.completion JSON response. */
async function aggregateSSE(res: Response): Promise<Response> {
  const text = await res.text();
  let content = "";
  let model = "";
  let finish = "stop";
  let id = " aggregated";
  let created = Math.floor(Date.now() / 1000);
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload) as {
        model?: string;
        id?: string;
        created?: number;
        choices?: Array<{
          finish_reason?: string;
          delta?: { content?: string; reasoning_content?: string };
        }>;
      };
      if (obj.model) model = obj.model;
      if (obj.id) id = obj.id.trim();
      if (obj.created) created = obj.created;
      const ch = obj.choices?.[0];
      if (ch?.finish_reason) finish = ch.finish_reason;
      if (ch?.delta?.content) content += ch.delta.content;
    } catch {
      /* skip malformed chunks */
    }
  }
  return json(200, {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finish,
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

async function forward(
  cfg: Config,
  conn: ConnectionCfg,
  url: string,
  incoming: Headers,
  body: BodyInit | null,
  kind: "openai" | "anthropic"
): Promise<Response> {
  const isJson = (incoming.get("content-type") || "").includes("json");
  const headers = buildHeaders(conn, incoming, isJson);
  if (conn.provider === "cloudflare-ai" && conn.accountId) {
    url = url.replace(
      "https://api.cloudflare.com/client/v4/accounts",
      `https://api.cloudflare.com/client/v4/accounts/${conn.accountId}`
    );
  }
  const res = await fetch(url, { method: "POST", headers, body });
  if (RETRY_STATUSES.has(res.status) && conn.provider) {
    // drain body so the connection can be reused mentally; return marker
    return res;
  }
  void kind;
  return res;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "authorization,content-type,x-api-key,anthropic-version",
        },
      });
    }

    if (url.pathname === "/health") {
      try {
        const cfg = await loadConfig(env);
        return json(200, {
          ok: true,
          connections: cfg.connections.length,
          combos: Object.keys(cfg.combos).length,
          prefixes: [...new Set(cfg.connections.map((c) => c.prefix).filter(Boolean))],
        });
      } catch (e) {
        return json(500, { ok: false, error: String(e) });
      }
    }

    let authed = false;
    if (url.pathname.startsWith("/v1/")) {
      try {
        const cfg = await loadConfig(env);
        const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
        authed = cfg.authKeys.includes(got);
      } catch {
        authed = false;
      }
    }

    if (url.pathname.startsWith("/v1/")) {
      if (!authed && request.method !== "OPTIONS") {
        return json(401, { error: { message: "invalid api key", type: "auth_error" } });
      }

      let cfg: Config;
      try {
        cfg = await loadConfig(env);
      } catch (e) {
        return json(500, { error: { message: `config error: ${String(e)}` } });
      }

      if (url.pathname === "/v1/models" && request.method === "GET") {
        const ids = new Set<string>();
        for (const c of Object.keys(cfg.combos)) ids.add(`combo/${c}`);
        for (const c of cfg.connections) {
          if (c.prefix) ids.add(`${c.prefix}/…`);
        }
        for (const c of cfg.connections) if (c.defaultModel) ids.add(c.defaultModel);
        for (const a of Object.keys(cfg.aliases)) ids.add(a);
        const data = [...ids].map((i) => ({ id: i, object: "model", owned_by: "zay-router" }));
        return json(200, { object: "list", data });
      }

      // Extract model from JSON or multipart
      let model = "";
      let bodyInit: BodyInit | null = null;
      let jsonBody: Record<string, unknown> | null = null;
      const ctype = request.headers.get("content-type") || "";
      if (ctype.includes("multipart/form-data")) {
        const fd = await request.formData();
        model = String(fd.get("model") || "");
        bodyInit = fd;
      } else if (request.method === "POST") {
        const text = await request.text();
        try {
          jsonBody = JSON.parse(text) as Record<string, unknown>;
          model = String(jsonBody.model || "");
        } catch {
          bodyInit = text;
        }
      }

      const kind: "openai" | "anthropic" = url.pathname.endsWith("/messages")
        ? "anthropic"
        : "openai";

      const candidates = model ? resolve(cfg, model) : [];
      if (!candidates.length) {
        return json(404, {
          error: {
            message:
              `model '${model}' not routable in cloud twin (v1). ` +
              `Try a combo (${Object.keys(cfg.combos).join(", ")}) or a prefixed model ` +
              `(${[...new Set(cfg.connections.map((c) => c.prefix).filter(Boolean))].join(", ")}). ` +
              `OAuth-harvest models (ag/, kiro, cursor, qoder) need local 9router or v2.`,
            type: "model_not_found",
          },
        });
      }

      let lastErr = "";
      for (const { conn, upstreamModel } of candidates) {
        let target: string | null = null;
        if (kind === "anthropic" && conn.type !== "builtin") {
          target = upstreamChatUrl(cfg, conn, "anthropic");
        } else if (
          url.pathname === "/v1/chat/completions" ||
          url.pathname === "/v1/responses"
        ) {
          target = upstreamChatUrl(cfg, conn, "openai");
        } else {
          target = mediaUrl(cfg, conn, url.pathname);
          if (!target && conn.type === "builtin") {
            // generic passthrough onto catalog baseUrl's host
            try {
              const u = new URL(cfg.providers[conn.provider]?.baseUrl || conn.baseUrl);
              target = `${u.origin}${url.pathname}`;
            } catch {
              target = null;
            }
          } else if (!target) {
            target = conn.baseUrl.replace(/\/+$/, "") + url.pathname;
          }
        }
        if (!target) continue;

        // Rewrite model in body
        let sendBody: BodyInit | null = bodyInit;
        const clientWantedStream = !!(jsonBody && jsonBody.stream === true);
        if (jsonBody) {
          const nb: Record<string, unknown> = { ...jsonBody, model: upstreamModel };
          if (conn.forceStream) nb.stream = true;
          sendBody = JSON.stringify(nb);
        } else if (bodyInit instanceof FormData) {
          const fd2 = new FormData();
          bodyInit.forEach((v, k) => {
            if (k === "model") fd2.append("model", upstreamModel);
            else fd2.append(k, v);
          });
          sendBody = fd2;
        }

        try {
          const res = await forward(cfg, conn, target, request.headers, sendBody, kind);
          if (res.ok || !RETRY_STATUSES.has(res.status)) {
            if (conn.forceStream && !clientWantedStream && (res.headers.get("content-type") || "").includes("event-stream")) {
              const agg = await aggregateSSE(res);
              const ah = new Headers({ "content-type": "application/json", "access-control-allow-origin": "*" });
              ah.set("x-router-conn", `${conn.provider}${conn.label ? "/" + conn.label : ""}`);
              return new Response(agg.body, { status: 200, headers: ah });
            }
            const rh = new Headers();
            res.headers.forEach((v, k) => {
              if (!DROP_RES_HEADERS.has(k.toLowerCase())) rh.set(k, v);
            });
            rh.set("access-control-allow-origin", "*");
            rh.set("x-router-conn", `${conn.provider}${conn.label ? "/" + conn.label : ""}`);
            return new Response(res.body, { status: res.status, headers: rh });
          }
          lastErr = `${conn.provider}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
          // model-not-found on a prefixed single connection: retrying others of same prefix is pointless; break handled by candidates list
        } catch (e) {
          lastErr = `${conn.provider}: ${String(e)}`;
        }
      }
      return json(502, {
        error: { message: `all candidates failed. last: ${lastErr || "none"}`, type: "router_error" },
      });
    }

    return json(404, { error: { message: "not found" } });
  },
} satisfies ExportedHandler<Env>;
