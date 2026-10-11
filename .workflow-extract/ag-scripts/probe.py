"""Read-only probe of 9router bundle files for Antigravity protocol strings.

Usage: python -I probe.py <mode> <file> [args...]
modes:
  head <n>            print first n chars
  win <pat> <radius>  print windows around each match of pat (regex), max 20
  all <pat>           print all match offsets
"""
import re
import sys
from pathlib import Path


def main() -> None:
    mode = sys.argv[1]
    path = Path(sys.argv[2])
    text = path.read_text(encoding="utf-8", errors="replace")
    print(f"len={len(text)}")
    if mode == "head":
        n = int(sys.argv[3])
        print(text[:n])
    elif mode == "win":
        pat = sys.argv[3]
        radius = int(sys.argv[4]) if len(sys.argv) > 4 else 800
        hits = list(re.finditer(pat, text))
        print(f"hits={len(hits)}")
        for m in hits[:20]:
            a = max(0, m.start() - radius)
            b = min(len(text), m.end() + radius)
            print(f"\n===== {m.group(0)!r} @{m.start()} [{a}:{b}] =====")
            print(text[a:b])
    elif mode == "all":
        pat = sys.argv[3]
        print([m.start() for m in re.finditer(pat, text)])
    else:
        raise SystemExit(f"unknown mode {mode}")


if __name__ == "__main__":
    main()
