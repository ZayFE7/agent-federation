"""Extract the Blip mascot rig (CSS + SVG + state driver) from the design kit
into standalone assets under ui/ for the Federation console."""
import re
from pathlib import Path

src = Path(r"E:\Users\Zay L\agent-federation\design-extract\blip-mascot.html").read_text(encoding="utf-8")
ui = Path(r"E:\Users\Zay L\agent-federation\ui")
ui.mkdir(exist_ok=True)

# CSS: full <style> block (rig CSS + demo layout; demo rules are scoped and harmless)
css_m = re.search(r"<style>(.*?)</style>", src, re.S)
css = css_m.group(1)
# Drop the demo-only page rules that clash with the console (body/top/grid/list demo styles)
for pat in [
    r"body\{[^}]*\}\s*",
    r"\.top\{[^}]*\}[^.]*?\.sm\{[^}]*\}\s*",
    r"\.grid\{[^}]*\}\s*",
    r"\.list\{[^}]*\}\s*",
    r"\.li\{[^}]*\}\s*",
    r"\.li i\{[^}]*\}\s*",
    r"\.li b\{[^}]*\}\s*",
    r"\.li small\{[^}]*\}\s*",
    r"\.li\[aria-pressed=true\]\{[^}]*\}\s*",
    r"h2\{[^}]*\}\s*",
    r"\.cap p\{[^}]*\}\s*",
    r"\.sm\{[^}]*\}\s*",
]:
    css = re.sub(pat, "", css)
(ui / "blip-rig.css").write_text(css, encoding="utf-8")

# SVG: the mascot canvas element
svg_m = re.search(r"(<svg id=\"mx\".*?</svg>)", src, re.S)
if not svg_m:
    # fallback: first svg with viewBox -20
    svg_m = re.search(r"(<svg[^>]*viewBox=\"-20[^\"]*\".*?</svg>)", src, re.S)
svg = svg_m.group(1)
(ui / "blip-rig.svg").write_text(svg, encoding="utf-8")

# JS: ST table + set() driver, wrapped as an ES module factory
js_m = re.search(r"const ST=(\{.*?\});\s*Object\.assign\(ST,(\{.*?\})\);", src, re.S)
st_body = js_m.group(1) + js_m.group(2) if js_m else None
if not st_body:
    # ST may be assigned in two chunks; grab from const ST= to set("idle");
    st_m = re.search(r"(const ST=\{.*?\nset\(\"idle\"\);)", src, re.S)
    st_body = st_m.group(1) if st_m else None

driver = f"""
// Blip mascot rig driver (extracted from the design kit)
export const ST = {js_m.group(1) if js_m else '{}'};
Object.assign(ST, {js_m.group(2) if js_m else '{{}}'});

export function attachBlip(root) {{
  const m = root.querySelector("#mx") || root.querySelector("svg");
  if (!m) throw new Error("mascot svg not found");
  const sp = (k, v) => m.style.setProperty(k, v);
  let cur = "idle";
  function set(k) {{
    const s = ST[k] || ST.idle;
    m.classList.remove("chg");
    void m.getBoundingClientRect();
    m.classList.add("chg");
    cur = k;
    const [la, ra, w, wd, ex, ey, by, ba, bo] = s.p;
    m.dataset.s = k;
    m.dataset.e = s.e;
    m.dataset.m = s.m;
    sp("--la", la + "deg"); sp("--ra", ra + "deg"); sp("--w", w + "deg");
    sp("--wd", wd + "s"); sp("--ex", ex + "px"); sp("--ey", ey + "px");
    sp("--hx", ex * 0.3 + "px"); sp("--hy", ey * 0.25 + "px");
    sp("--by", by + "px"); sp("--ba", ba + "deg"); sp("--bo", bo);
    sp("--bk", s.b[0]); sp("--bd", s.b[1] + "s"); sp("--sk", s.b[2] ? "shd" : "none");
    sp("--ek", s.k ? s.k[0] : "none"); sp("--ekd", s.k ? s.k[1] + "s" : "3s");
    document.documentElement.style.setProperty("--t", s.c);
    m.querySelectorAll(".pr").forEach((p) => p.classList.toggle("on", p.classList.contains("pr-" + k)));
    // idle life: random micro-animations
    if (k === "idle") {{
      setInterval(() => {{
        if (cur !== "idle") return;
        const a = ["wink", "twitch", "hip"][Math.random() * 3 | 0];
        m.classList.add(a);
        setTimeout(() => m.classList.remove(a), 1000);
      }}, 5200);
    }}
    return s;
  }}
  // eyes follow pointer
  let pq = 0;
  addEventListener("pointermove", (e) => {{
    if (pq) return;
    pq = requestAnimationFrame(() => {{
      pq = 0;
      const r = m.getBoundingClientRect();
      const c = (v, a, b) => Math.max(-1, Math.min(1, ((v - a) / b) * 2));
      m.style.setProperty("--px", c(e.clientX, r.left + r.width / 2, innerWidth) * 2.6 + "px");
      m.style.setProperty("--py", c(e.clientY, r.top + r.height / 2, innerHeight) * 2.2 + "px");
    }});
  }});
  set("idle");
  return {{ set, ST, el: m, current: () => cur }};
}}
"""
(ui / "blip-rig.js").write_text(driver, encoding="utf-8")
print("css", len(css), "svg", len(svg), "js", len(driver))
print("states:", len(re.findall(r"^\w+:\{", (ui / "blip-rig.js").read_text(), re.M)))
