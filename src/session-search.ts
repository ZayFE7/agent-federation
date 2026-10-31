// Cross-session search, kept dependency-free so src/routes.ts may value-import it
// and tests/session-search.test.mjs can run it under plain Node. The transcript
// search itself lives in each session DO (the harness FTS index plus the display
// table); this module owns only the answer shape: one snippet per hit, the
// session title attached, strongest recency first.

/** One raw hit as a session DO reports it. */
export interface SearchHitInput {
  id: string;
  role: string;
  content: string;
  createdAt?: string;
  sessionId?: string;
}

/** The title half of a registry row, all this module needs from it. */
export interface SearchSessionMeta {
  id: string;
  title: string;
}

/** One row the console renders. */
export interface MergedSearchHit {
  id: string;
  role: string;
  content: string;
  createdAt?: string;
  sessionId: string;
  sessionTitle: string;
}

/** Longest snippet a hit may carry; an assistant reply can be tens of kilobytes. */
const SNIPPET_MAX = 360;

/**
 * A query the route will run, or null when it is too small or too large. The
 * two-character floor is what keeps a single letter from waking every session.
 */
export function clampSearchQuery(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length < 2 || text.length > 200) return null;
  return text;
}

/** A hit's readable window around the first match, with its length bounded. */
export function searchSnippet(content: string, query: string): string {
  const text = String(content ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= SNIPPET_MAX) return text;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return `${text.slice(0, SNIPPET_MAX)}...`;
  const start = Math.max(0, at - 120);
  const end = Math.min(text.length, at + query.length + 200);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

/**
 * Merge per-session answers into one list. The registry rows decide the title,
 * so a session the registry no longer lists is dropped rather than shown as a
 * dead link. Recency is the second key after per-session relevance because the
 * SDK's result carries no score.
 */
export function mergeSearchHits(
  hits: SearchHitInput[],
  sessions: SearchSessionMeta[],
  limit = 20,
  query = ""
): MergedSearchHit[] {
  const titles = new Map(sessions.map((row) => [row.id, row.title]));
  const seen = new Set<string>();
  const rows: MergedSearchHit[] = [];
  for (const hit of hits) {
    const sessionId = String(hit?.sessionId ?? "");
    if (!sessionId || !titles.has(sessionId)) continue;
    const content = String(hit.content ?? "");
    if (!content.trim()) continue;
    const key = `${sessionId}\u0000${hit.role}\u0000${content.slice(0, 160)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id: String(hit.id ?? ""),
      role: String(hit.role || "user"),
      content: searchSnippet(content, query),
      ...(hit.createdAt ? { createdAt: hit.createdAt } : {}),
      sessionId,
      sessionTitle: String(titles.get(sessionId) ?? ""),
    });
  }
  rows.sort((a, b) => {
    const at = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
    return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
  });
  return rows.slice(0, Math.max(1, Math.min(50, limit)));
}
