import sqlite3, json
con = sqlite3.connect("file:///E:/Users/Zay%20L/AppData/Roaming/9router/db/data.sqlite?mode=ro", uri=True)
cur = con.cursor()
print("customModels key samples:")
for r in cur.execute("SELECT key, substr(value,1,80) FROM kv WHERE scope='customModels' LIMIT 5"):
    print(" ", r)
print("mimo in customModels keys:")
for r in cur.execute("SELECT key FROM kv WHERE scope='customModels' AND key LIKE '%mimo%' LIMIT 10"):
    print(" ", r[0])
print("mimo in customModels values:")
for r in cur.execute("SELECT key FROM kv WHERE scope='customModels' AND value LIKE '%mimo-v2.6%' LIMIT 10"):
    print(" ", r[0])
print("aliases raw:")
for r in cur.execute("SELECT key, value FROM kv WHERE scope='modelAliases'"):
    print(" ", r)
con.close()
