from pathlib import Path
d = Path(r"C:\npm-global\node_modules\9router\app\.next-cli-build\server\chunks\458.js").read_text(encoding="utf-8", errors="replace")
i = d.find('alias:"oc"')
print(d[max(0, i - 350) : i + 450] if i >= 0 else "not found")
