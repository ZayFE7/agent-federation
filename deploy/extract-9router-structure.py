import sqlite3, json

uri = "file:E:/Users/Zay%20L/AppData/Roaming/9router/db/data.sqlite?mode=ro"
con = sqlite3.connect(uri, uri=True)
cur = con.cursor()

print("=== providerNodes ===")
for r in cur.execute("SELECT id, type, name, data FROM providerNodes"):
    d = json.loads(r[3]) if r[3] else {}
    keys = sorted(d.keys())
    print(f"  [{r[0]}] {r[2]} type={r[1]} data_keys={keys[:10]}")

print("\n=== providerConnections (no secrets) ===")
from collections import Counter
c = Counter()
for r in cur.execute("SELECT provider, authType, priority, isActive, data FROM providerConnections"):
    c[r[0]] += 1
    d = json.loads(r[4]) if r[4] else {}
    # only show non-secret-ish keys
    safe = {k: (type(v).__name__ if not isinstance(v, (str, int, float, bool)) else ("***" if any(s in k.lower() for s in ("key", "token", "secret", "cookie", "auth", "password")) else v)) for k, v in d.items()}
    print(f"  {r[0]:20s} auth={r[1]:10s} prio={r[2]} active={r[3]} fields={safe}")
print("\nCounts by provider:", dict(c))

print("\n=== combos ===")
for r in cur.execute("SELECT id, name, kind, models FROM combos"):
    m = r[3]
    try:
        ml = json.loads(m)
        preview = ml if isinstance(ml, list) and len(ml) <= 8 else f"{type(ml).__name__} len={len(ml) if hasattr(ml, '__len__') else '?'}"
    except Exception:
        preview = str(m)[:120]
    print(f"  [{r[0]}] {r[1]} kind={r[2]} models={preview}")

print("\n=== apiKeys ===")
for r in cur.execute("SELECT id, name, isActive FROM apiKeys"):
    print(f"  id={r[0]} name={r[1]} active={r[2]}")

print("\n=== settings (keys only) ===")
for r in cur.execute("SELECT data FROM settings"):
    d = json.loads(r[0]) if r[0] else {}
    print("  ", {k: (type(v).__name__) for k, v in d.items()})

print("\n=== kv scopes ===")
for r in cur.execute("SELECT scope, COUNT(*) FROM kv GROUP BY scope"):
    print(f"  {r[0]}: {r[1]}")
con.close()
