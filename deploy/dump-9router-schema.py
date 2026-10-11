import sqlite3

uri = "file:E:/Users/Zay%20L/AppData/Roaming/9router/db/data.sqlite?mode=ro"
con = sqlite3.connect(uri, uri=True)
cur = con.cursor()
tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
print("TABLES:", len(tables))
for t in tables:
    try:
        n = cur.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
        cols = [c[1] for c in cur.execute(f'PRAGMA table_info("{t}")')]
        print(f"- {t} ({n}): {cols[:16]}")
    except Exception as e:
        print(f"- {t}: ERR {e}")
con.close()
