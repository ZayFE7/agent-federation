"""Slice minified bundle files by offset ranges and grep for registration markers.

Usage: python -I slice.py <file> <cmd> [args]
cmds:
  slice <start> <end>
  find <regex> [maxhits]     - offsets + 200-char previews
  kzl <regex>                - find "(0,X.kz)(" style provider-pair registrations
"""
import re
import sys
from pathlib import Path


def main() -> None:
    path = Path(sys.argv[1])
    cmd = sys.argv[2]
    text = path.read_text(encoding="utf-8", errors="replace")
    print(f"len={len(text)}")
    if cmd == "slice":
        a, b = int(sys.argv[3]), int(sys.argv[4])
        print(text[a:b])
    elif cmd == "find":
        pat = sys.argv[3]
        maxhits = int(sys.argv[4]) if len(sys.argv) > 4 else 30
        hits = list(re.finditer(pat, text))
        print(f"hits={len(hits)}")
        for m in hits[:maxhits]:
            a = max(0, m.start() - 100)
            b = min(len(text), m.end() + 200)
            print(f"@{m.start()}: ...{text[a:b]}...")
    elif cmd == "kzl":
        # registrations look like (0,d.kz)(e.h.ANTIGRAVITY,e.h.OPENAI,...) or reversed
        pat = sys.argv[3] if len(sys.argv) > 3 else r"\(\w+\.kz\)\("
        for m in re.finditer(pat + r"([^)]{0,200})\)", text):
            print(f"@{m.start()}: {m.group(0)[:260]}")
    else:
        raise SystemExit(f"unknown cmd {cmd}")


if __name__ == "__main__":
    main()
