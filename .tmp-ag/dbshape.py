import sqlite3, json, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
con = sqlite3.connect(
    "file:E:/Users/Zay%20L/AppData/Roaming/9router/db/data.sqlite?mode=ro",
    uri=True,
    timeout=3,
)
cur = con.cursor()
cur.execute("PRAGMA table_info(providerConnections)")
print("cols:", [c[1] for c in cur.fetchall()])
cur.execute(
    "select id, provider, authType, name, isActive, data from providerConnections where provider='antigravity'"
)
rows = cur.fetchall()
print("count", len(rows))


def shape(o, depth=0):
    if depth > 4:
        return "..."
    if isinstance(o, dict):
        return {k: shape(v, depth + 1) for k, v in o.items()}
    if isinstance(o, list):
        return ["<list len %d>" % len(o)]
    if isinstance(o, str):
        return "<str len %d>" % len(o)
    return type(o).__name__


for r in rows[:2]:
    d = json.loads(r[5]) if r[5] else {}
    print("id=", r[0], "provider=", r[1], "authType=", r[2], "name=", r[3], "active=", r[4])
    print("  data:", json.dumps(shape(d))[:2000])
con.close()
