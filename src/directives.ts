// Deterministic directives: the user typed a shell command or a search query
// themselves, so there is no reason to involve the model. The colon is
// required: matching on whitespace would make an ordinary message like "run the
// tests" execute the shell command "the tests".
//
// Both arms require non-space content (P2-14): `"run:  "` used to match with an
// empty argument and dispatched `execSandbox("")`. The regex is the fix and the
// `!arg` guard is the belt.
//
// Dependency-free so an offline test can load it under plain Node.

export interface Directive {
  kind: "exec" | "search";
  arg: string;
}

const RUN_RE = /^(run|exec|execute):\s*(\S.*)$/is;
const SEARCH_RE = /^search:\s*(\S.*)$/is;

export function parseDirective(text: string): Directive | null {
  const value = typeof text === "string" ? text : "";
  const run = RUN_RE.exec(value);
  if (run) {
    const arg = (run[2] || "").trim();
    return arg ? { kind: "exec", arg } : null;
  }
  const search = SEARCH_RE.exec(value);
  if (search) {
    const arg = (search[1] || "").trim();
    return arg ? { kind: "search", arg } : null;
  }
  return null;
}
