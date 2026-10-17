// Offline unit test for the chat markdown renderer.
// Extracts `const esc=...` and `const md=...` verbatim from ui/index.html and
// asserts the rendered HTML. Run: node tests/markdown.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "ui", "index.html"), "utf8");

function extract(name, endMarker) {
  const start = html.indexOf("const " + name + "=");
  if (start < 0) throw new Error("could not find const " + name);
  const e = html.indexOf(endMarker, start);
  if (e < 0) throw new Error("could not find end of const " + name);
  return html.slice(start, e).trim().replace(/;$/, "");
}

// Build a module that defines esc + md exactly as shipped.
// `esc` ends where the next top-level `const md=` begins; `md` ends at `let cur=`.
const src =
  extract("esc", "\nconst md=") +
  "\n" +
  extract("md", "\nlet cur=") +
  "\nexport {md, esc};";
if (process.env.MD_DEBUG) {
  console.log("--- extracted md() ---");
  console.log(src);
  console.log("--- end ---");
}
const modUrl =
  "data:text/javascript;base64," + Buffer.from(src, "utf8").toString("base64");
const { md, esc } = await import(modUrl);

let pass = 0,
  fail = 0;
const cases = [];
const t = (label, input, check) => cases.push([label, input, check]);

// code fence -> <pre><code>, content escaped, language stripped
t(
  "fenced code block",
  "```py\nprint('hi')\n```",
  (o) => /<pre><code>print\(&#039;hi&#039;\)|<pre><code>print\('hi'\)/.test(o) && !/```/.test(o) && /py/.test(o) === false
);
t(
  "fence lang label removed",
  "```python\ncode here\n```",
  (o) => !/python/.test(o) && /<pre><code>code here<\/code><\/pre>/.test(o)
);
// inline code
t("inline code", "use `foo()` now", (o) => /<code>foo\(\)<\/code>/.test(o));
// bold + italic
t("bold", "this is **bold** text", (o) => /<strong>bold<\/strong>/.test(o));
t("italic", "this is *ital* text", (o) => /<em>ital<\/em>/.test(o));
// headings
t("heading", "## Title here", (o) => /<h4>Title here<\/h4>/.test(o));
// list
t(
  "unordered list",
  "- one\n- two\n- three",
  (o) => /<ul><li>one<\/li><li>two<\/li><li>three<\/li><\/ul>/.test(o)
);
t(
  "ordered list",
  "1. first\n2. second",
  (o) => /<ol><li>first<\/li><li>second<\/li><\/ol>/.test(o)
);
// link + unsafe protocol rejected
t(
  "safe link",
  "[docs](https://example.com/a)",
  (o) => /<a href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer">docs<\/a>/.test(o)
);
t(
  "js link not turned into anchor",
  "[x](javascript:alert(1))",
  (o) => !/<a /.test(o)
);
// XSS: raw html must be escaped even inside markdown
t(
  "script tag escaped",
  "<script>alert(1)<\/script> hello",
  (o) => o.includes("&lt;script&gt;") && !/<script>/.test(o)
);
t(
  "bold inside escaped angle",
  "**<img src=x onerror=alert(1)>**",
  (o) => !/<img/.test(o) && o.includes("&lt;img")
);
// code content is not markdown-processed
t(
  "no bold inside code",
  "`**notbold**`",
  (o) => /<code>\*\*notbold\*\*<\/code>/.test(o) && !/<strong>/.test(o)
);
// multi-paragraph
t(
  "two paragraphs",
  "para one\n\npara two",
  (o) => /<p>para one<\/p><p>para two<\/p>/.test(o)
);

for (const [label, input, check] of cases) {
  let out, ok, err = "";
  try {
    out = md(input);
    ok = check(out);
  } catch (e) {
    err = String(e && e.message);
  }
  if (ok) {
    pass++;
    console.log("  PASS " + label);
  } else {
    fail++;
    console.log("  FAIL " + label + (err ? "  [threw: " + err + "]" : ""));
    console.log("    in:  " + JSON.stringify(input));
    console.log("    out: " + JSON.stringify(out));
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
