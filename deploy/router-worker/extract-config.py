"""Extract a router config from local 9router (SQLite + provider catalog chunk).

Read-only on the 9router DB. Emits router-config.json (contains API keys:
gitignored; pushed to KV only).
"""
import json
import re
import sqlite3
import sys
from pathlib import Path

DB = "file:///E:/Users/Zay%20L/AppData/Roaming/9router/db/data.sqlite?mode=ro"
CHUNK = Path(r"C:\npm-global\node_modules\9router\app\.next-cli-build\server\chunks\458.js")
OUT = Path(__file__).parent / "router-config.json"

# ---- 1. Provider catalog from the Next.js chunk ----
data = CHUNK.read_text(encoding="utf-8", errors="replace")
# Top-level providers carry id + priority; models carry id + name.
prov_iter = list(re.finditer(r'id:"([a-z0-9-]+)",priority:(\d+)', data))
providers = {}
for m in prov_iter:
    pid = m.group(1)
    block = data[m.start() : m.start() + 4000]
    tb = re.search(r"transport:\{baseUrl:\"([^\"]+)\"", block)
    if not tb:
        continue
    entry = {"baseUrl": tb.group(1), "priority": int(m.group(2))}
    # Gemini's catalog baseUrl is the models-list/validate endpoint; the
    # OpenAI-compatible chat endpoint is a well-known sibling path.
    if "generativelanguage.googleapis.com" in entry["baseUrl"] and "openai" not in entry["baseUrl"]:
        entry["baseUrl"] = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    for key, pat in (
        ("stt", r"sttConfig:\{baseUrl:\"([^\"]+)\""),
        ("tts", r"ttsConfig:\{baseUrl:\"([^\"]+)\""),
        ("image", r"imageConfig:\{baseUrl:\"([^\"]+)\""),
        ("embeddings", r"embeddingsConfig:\{baseUrl:\"([^\"]+)\""),
        ("imageToText", r"imageToTextConfig:\{baseUrl:\"([^\"]+)\""),
    ):
        mm = re.search(pat, block)
        if mm:
            entry[key] = mm.group(1)
    providers[pid] = entry

# ---- 2. SQLite: nodes, connections, combos, keys, aliases ----
con = sqlite3.connect(DB, uri=True)
cur = con.cursor()

nodes = {}
for nid, ntype, name, jdata in cur.execute("SELECT id, type, name, data FROM providerNodes"):
    d = json.loads(jdata) if jdata else {}
    nodes[nid] = {
        "type": ntype,  # openai-compatible | anthropic-compatible
        "baseUrl": d.get("baseUrl", ""),
        "prefix": d.get("prefix", ""),
        "name": name,
    }

connections = []
for provider, auth, prio, active, jdata in cur.execute(
    "SELECT provider, authType, priority, isActive, data FROM providerConnections"
):
    if auth != "apikey" or not active:
        continue
    d = json.loads(jdata) if jdata else {}
    key = d.get("apiKey") or ""
    if not key:
        continue
    conn = {
        "provider": provider,
        "key": key,
        "priority": int(prio or 1),
        "defaultModel": d.get("defaultModel") or "",
    }
    if provider in nodes:
        n = nodes[provider]
        conn["type"] = "anthropic" if n["type"].startswith("anthropic") else "openai"
        conn["baseUrl"] = n["baseUrl"].rstrip("/")
        conn["prefix"] = n["prefix"]
        conn["label"] = n["name"]
    elif provider in providers:
        conn["type"] = "builtin"
        conn["baseUrl"] = providers[provider]["baseUrl"]
        conn["label"] = provider
        psd = d.get("providerSpecificData") or {}
        # Cloudflare AI needs account id in URL paths
        if provider == "cloudflare-ai" and isinstance(psd, dict):
            acct = psd.get("accountId") or psd.get("account_id")
            if acct:
                conn["accountId"] = acct
    else:
        continue  # unknown provider type (oauth, local ollama, etc.)
    connections.append(conn)

combos = {}
for _cid, name, _kind, jmodels in cur.execute("SELECT id, name, kind, models FROM combos"):
    try:
        ml = json.loads(jmodels)
        if isinstance(ml, list) and ml:
            combos[name] = ml
    except Exception:
        pass

auth_keys = [r[0] for r in cur.execute("SELECT key FROM apiKeys WHERE isActive = 1")]

aliases = {}
for scope, k, v in cur.execute("SELECT scope, key, value FROM kv WHERE scope = 'modelAliases'"):
    val = v.strip()
    # values sometimes arrive JSON-quoted
    if len(val) >= 2 and val[0] == '"' and val[-1] == '"':
        val = val[1:-1]
    aliases[k] = val

con.close()

config = {
    "authKeys": auth_keys,
    "providers": providers,
    "connections": connections,
    "combos": combos,
    "aliases": aliases,
}

OUT.write_text(json.dumps(config, indent=1), encoding="utf-8")
print(f"providers(catalog)={len(providers)} connections(apikey)={len(connections)} combos={len(combos)} aliases={len(aliases)} authKeys={len(auth_keys)}")
by = {}
for c in connections:
    by[c["provider"]] = by.get(c["provider"], 0) + 1
print("connections by provider:", json.dumps(by, indent=1))
# media-capable builtin providers
media = {p: {k: v for k, v in e.items() if k in ("stt", "tts", "image", "embeddings", "imageToText")} for p, e in providers.items() if any(k in e for k in ("stt", "tts", "image", "embeddings", "imageToText"))}
print("media-capable providers:", json.dumps(media, indent=1)[:2000])
sys.exit(0)
