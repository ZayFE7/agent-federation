import sys, io
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
path = sys.argv[1]
start = int(sys.argv[2])
end = int(sys.argv[3])
data = io.open(path, "r", encoding="utf-8", errors="replace").read()
sys.stdout.write(data[start:end])
