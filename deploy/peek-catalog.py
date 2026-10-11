from pathlib import Path
f = Path(r"C:\npm-global\node_modules\9router\app\.next-cli-build\server\chunks\458.js")
data = f.read_text(encoding="utf-8", errors="replace")
print("file len", len(data))
needle = 'baseUrl:"https://api.groq.com/openai/v1/chat/completions"'
i = data.find(needle)
print("groq idx", i)
if i >= 0:
    start = max(0, i - 400)
    print(data[start : i + 800])
