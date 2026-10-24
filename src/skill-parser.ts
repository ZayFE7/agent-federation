// Claude Code style SKILL.md parsing. Dependency-free so the registry and an
// offline test can use it without a Worker or a YAML library.

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const MAX_BODY = 40_000;
const MAX_DESCRIPTION = 300;

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
}

function normalizeName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && /^["'].*["']$/s.test(trimmed)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

interface Split {
  front: string;
  body: string;
}

function splitFrontmatter(text: string): Split {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { front: "", body: normalized.trim() };
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return { front: "", body: normalized.trim() };
  return {
    front: normalized.slice(4, end),
    body: normalized.slice(end + 4).replace(/^\n+/, "").trim(),
  };
}

function field(front: string, key: string): string {
  const lines = front.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = new RegExp(`^${key}:\\s*(.*)$`).exec(lines[i]);
    if (!match) continue;
    const raw = match[1].trim();
    if (raw && raw !== ">" && raw !== ">-" && raw !== "|" && raw !== "|-") {
      return unquote(raw);
    }
    const parts: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (!/^\s+/.test(lines[j])) break;
      parts.push(lines[j].trim());
    }
    return unquote(parts.join(" "));
  }
  return "";
}

/** The parsed skill, or a reason the text cannot be installed. */
export function parseSkill(
  text: string,
  fallbackName = ""
): { ok: true; skill: ParsedSkill } | { ok: false; error: string } {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: "SKILL.md is empty" };
  }
  const { front, body } = splitFrontmatter(text);
  if (!body) return { ok: false, error: "the skill has no instructions below the frontmatter" };
  if (body.length > MAX_BODY) return { ok: false, error: "the skill body is too large" };
  const heading = /^#\s+(.+)$/m.exec(body)?.[1] ?? "";
  const name = normalizeName(field(front, "name") || fallbackName || heading);
  if (!SKILL_NAME_RE.test(name)) {
    return {
      ok: false,
      error: "name must start with a letter or number and use lowercase letters, numbers, - or _",
    };
  }
  const description =
    unquote(field(front, "description")) ||
    body
      .split("\n")
      .find((line) => line.trim() && !line.startsWith("#"))
      ?.trim() ||
    "";
  if (!description) return { ok: false, error: "description or a first paragraph is required" };
  if (description.length > MAX_DESCRIPTION) {
    return { ok: false, error: `description is over ${MAX_DESCRIPTION} characters` };
  }
  return {
    ok: true,
    skill: { name, description, body },
  };
}
