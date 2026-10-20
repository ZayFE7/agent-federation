// Single source of truth for facts about the sandbox the model is told about.
// Task 29 grows this into the full capability table.

// The E2B "base" template runs as a non-root user whose home is /home/user, so
// a path outside it cannot be created. Promising /workspace in a tool
// description tells the model to write where it has no permission.
export const SANDBOX_HOME = "/home/user";

// The tool set buildTools must wire by default. tests/tools.test.mjs compares
// the built set against this constant, so the two cannot drift.
export const EXPECTED_TOOLS: readonly string[] = Object.freeze([
  "exec",
  "web_search",
  "schedule_task",
  "save_workspace",
]);
