// Pure session-title parsing and prompt text (Task 9).
//
// Dependency-free on purpose: no imports at all, so a fresh clone can run
// `node tests/titles.test.mjs` with no build step. The JSON-to-string seam the
// router reply needs lives in parseTitle's argument, so src/agent.ts only has to
// hand over `data.choices?.[0]?.message?.content ?? ""`.

/** Longest title this parser aims for, counted in codepoints, not UTF-16 units. */
export const TITLE_MAX_CHARS = 40;

/**
 * A write that lands before the model answers, so a session never sits as
 * "New chat" while the title call runs. It strips directives, code fences,
 * links and Markdown, then keeps the first six words.
 */
export function provisionalTitle(first: string): string {
  const cleaned = collapseWhitespace(
    String(first ?? "")
      .replace(/^(?:run|exec|execute|search)\s*:\s*/i, "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[`#*_>]+/g, " ")
  );
  if (!cleaned) return "";
  const words = cleaned.split(" ").filter(Boolean).slice(0, 6).join(" ");
  return truncateFallback(words || cleaned);
}

/**
 * Completion ceiling for the title call. Reasoning counts against it: at 60 the
 * qwen pin returned `content: null` with `finish_reason: "length"` because the
 * reasoning field consumed the whole budget, and only at 300 did the title
 * arrive after 206 completion tokens. 512 keeps headroom for a longer think.
 */
export const TITLE_MAX_TOKENS = 512;

/** How many characters of the user's first turn the title prompt receives. */
const FIRST_MESSAGE_CHARS = 300;

/** ASCII only: the fallback's suffix must not depend on the model's output. */
const ELLIPSIS = "...";

/** The instruction the cheap model receives when a session needs its title. */
export const TITLE_SYSTEM =
  'You name chat sessions. Write a title of two to five words in sentence case, capitalizing only the first word and proper nouns. Use no quotes, no emoji, and no trailing period. Reply with only a JSON object in the form {"title":"..."} and nothing else.';

/** Drop Markdown fences: the cheap model sometimes wraps its JSON in them. */
function unfence(raw: string): string {
  return raw.replace(/```[a-zA-Z]*\s*/g, "").trim();
}

/**
 * Use a JSON object's string `title` when the reply is one; otherwise keep the
 * raw text. The cheap model returns the object form often enough that reading
 * it is part of the contract, not a nicety.
 */
function titleFromJson(raw: string): string {
  const object = raw.match(/\{[\s\S]*\}/);
  if (!object) return raw;
  try {
    const parsed = JSON.parse(object[0]) as { title?: unknown };
    return typeof parsed?.title === "string" ? parsed.title : raw;
  } catch {
    return raw;
  }
}

const QUOTE_PAIRS: Array<[string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["\u201C", "\u201D"],
  ["\u2018", "\u2019"],
];

/** Remove one layer of matching wrapping quotes, straight or curly. */
function stripWrappingQuotes(raw: string): string {
  const s = raw.trim();
  for (const [open, close] of QUOTE_PAIRS) {
    if (s.length >= open.length + close.length && s.startsWith(open) && s.endsWith(close)) {
      return s.slice(open.length, s.length - close.length).trim();
    }
  }
  return s;
}

/** A title is one line: collapse every whitespace run to a single space. */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Cut a model title to TITLE_MAX_CHARS codepoints. Prefer the last whitespace
 * at or before the limit and fall back to a hard cut for one long word.
 * Array.from counts codepoints, so an astral character is never split into two
 * lone UTF-16 surrogates.
 */
function truncateTitle(s: string): string {
  const chars = Array.from(s);
  if (chars.length <= TITLE_MAX_CHARS) return s;
  let cut = TITLE_MAX_CHARS;
  for (let i = TITLE_MAX_CHARS - 1; i >= 0; i--) {
    if (/\s/.test(chars[i])) {
      cut = i;
      break;
    }
  }
  const atBoundary = chars.slice(0, cut).join("").trimEnd();
  return atBoundary || chars.slice(0, TITLE_MAX_CHARS).join("");
}

/**
 * Cut the deterministic fallback to TITLE_MAX_CHARS codepoints and mark the cut
 * with an ASCII ellipsis. A short fallback is returned unchanged.
 */
function truncateFallback(s: string): string {
  const chars = Array.from(s);
  if (chars.length <= TITLE_MAX_CHARS) return s;
  return chars.slice(0, TITLE_MAX_CHARS).join("").trimEnd() + ELLIPSIS;
}

/**
 * Turn one cheap-model completion into a title. Empty or unusable output falls
 * back to the user's own first turn, so the fiber always has a deterministic
 * value to write when the model call fails.
 */
export function parseTitle(raw: string, fallback: string): string {
  const cleaned = collapseWhitespace(stripWrappingQuotes(titleFromJson(unfence(raw ?? ""))));
  if (cleaned) return truncateTitle(cleaned);
  const own = collapseWhitespace(fallback ?? "");
  if (!own) return "";
  return truncateFallback(own);
}

/**
 * The messages for the title completion: the fixed instruction plus the first
 * 300 codepoints of the user's triggering turn, and never more than that.
 */
export function titleMessages(
  first: string
): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: TITLE_SYSTEM },
    {
      role: "user",
      content: Array.from(first ?? "").slice(0, FIRST_MESSAGE_CHARS).join(""),
    },
  ];
}
