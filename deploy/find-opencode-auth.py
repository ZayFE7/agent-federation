import sqlite3, json
con = sqlite3.connect("file:///E:/Users/Zay%20L/AppData/Roaming/9router/db/data.sqlite?mode=ro", uri=True)
cur = con.cursor()
print("meta:", list(cur.execute("SELECT key FROM _meta")))
for (v,) in cur.execute("SELECT data FROM settings"):
    d = json.loads(v)
    print("settings keys:", list(d.keys()))
    for k in d:
        if "opencode" in k.lower() or "oc" == k.lower():
            print(" hit", k)
# search kv for opencode auth-ish
for r in cur.execute("SELECT scope, key FROM kv WHERE key LIKE '%opencode%' OR key LIKE '%zen%' LIMIT 15"):
    print("kv:", r)
con.close()
