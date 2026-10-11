import sys, re, io
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
path = sys.argv[1]
pat = sys.argv[2]
before = int(sys.argv[3]) if len(sys.argv) > 3 else 200
after = int(sys.argv[4]) if len(sys.argv) > 4 else 3000
data = io.open(path, "r", encoding="utf-8", errors="replace").read()
n = 0
for m in re.finditer(pat, data):
    n += 1
    s = max(0, m.start() - before)
    e = min(len(data), m.end() + after)
    print("===== match %d at %d =====" % (n, m.start()))
    print(data[s:e])
    print()
print("total", n)
