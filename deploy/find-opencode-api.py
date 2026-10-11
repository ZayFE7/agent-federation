from pathlib import Path
d = Path(r"C:\npm-global\node_modules\9router\app\.next-cli-build\server\chunks\458.js").read_text(encoding="utf-8", errors="replace")
i = d.find('alias:"oc"')
block = d[i : i + 2500]
print(block[:2500])
