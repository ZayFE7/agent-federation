// The one place the brain calls Parallel Web Search.
//
// Moved out of src/agent.ts with Task 31 so a sub-agent's `web_search` uses the
// same endpoint, the same key check and the same failure text as the main agent's.
// Throws with actionable text on every failure mode, because the harness records a
// thrown tool as an error the model can read; a caller that needs a text reply (the
// "search:" directive) catches it itself.

import type { Env } from "./types";
import type { SearchResult } from "./tools";

export async function searchParallel(
  env: Env,
  query: string
): Promise<SearchResult[]> {
  const q = (query || "").trim();
  if (!env.PARALLEL_API_KEY) {
    throw new Error(
      "web search is not configured on this worker (no PARALLEL_API_KEY). Tell the user search is unavailable."
    );
  }
  if (!q) {
    throw new Error(
      "web_search needs a non-empty query. Retry with what you want to find."
    );
  }
  let res: Response;
  try {
    res = await fetch("https://api.parallel.ai/v1/search", {
      method: "POST",
      headers: {
        "x-api-key": env.PARALLEL_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({ objective: q, search_queries: [q] }),
      // Search must fail fast, not hang the tool loop or the UI.
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new Error(`web search request failed: ${String(err)}`);
  }
  if (!res.ok) {
    const errText = (await res.text()).slice(0, 300);
    throw new Error(
      `web search failed (HTTP ${res.status}): ${errText}. The Parallel key may lack the Search product; tell the user.`
    );
  }
  const data = (await res.json()) as { results?: SearchResult[] };
  return data.results || [];
}
