from pathlib import Path
import re

for p in [
    Path(r"C:\npm-global\node_modules\9router\app\src\mitm\server.js"),
    Path(r"C:\npm-global\node_modules\9router\app\.next-cli-build\server\chunks\458.js"),
]:
    d = p.read_text(encoding="utf-8", errors="replace")
    hits = re.findall(r"https://opencode\.ai[^\"'\s`]{0,80}", d)
    print(p.name, "->", sorted(set(hits))[:12])
