// Contract tests for src/continuation.ts, the loop's completion guard.
// Plain Node, no framework: `node tests/continuation.test.mjs`. Silent on exit 0.

import assert from "node:assert/strict";
import {
  CONTINUATION_NUDGE,
  MAX_CONTINUATIONS,
  NO_SUMMARY,
  continuationInstruction,
  looksUnfinished,
  shouldContinue,
} from "../src/continuation.ts";

const failures = [];

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

check("catches the production promise that stopped the loop", () => {
  assert.equal(
    looksUnfinished(
      'The script worked, but I caught an off-by-one bug in my "largest prime" line, so I\'ll rerun that part to verify it.'
    ),
    true
  );
});

check("catches short future actions with a real verb", () => {
  assert.equal(looksUnfinished("Let me rerun the test to verify the fix."), true);
  assert.equal(looksUnfinished("I'll patch the script and run it again."), true);
  assert.equal(looksUnfinished("Next, I will check the docs for that endpoint."), true);
});

check("catches present-progressive intent that ended before the step", () => {
  assert.equal(
    looksUnfinished("I'm checking the official GitHub releases page to confirm which result is the most recent."),
    true
  );
  assert.equal(looksUnfinished("I'm pulling the changelog now."), true);
});

check("a completed answer is not unfinished", () => {
  assert.equal(looksUnfinished("Done. The script printed 42 and the tests pass."), false);
  assert.equal(looksUnfinished("I reran the script and verified the output."), false);
  assert.equal(looksUnfinished("The answer is 97; I checked it twice."), false);
});

check("an explicit 'not yet' is unfinished, even after a Done summary", () => {
  assert.equal(looksUnfinished("I haven't rerun anything yet."), true);
  assert.equal(looksUnfinished("I have not verified the result yet."), true);
  assert.equal(
    looksUnfinished(
      "I'll write the script and run it.\n\nThe script printed 29. I caught an off-by-one bug, so I'll rerun that part to verify it.\n\nDone — the script ran and printed 29, and I've stopped at the exact point you asked. I haven't rerun anything yet."
    ),
    true
  );
});

check("a negative finding is complete, not a promise", () => {
  assert.equal(looksUnfinished("I didn't find any results in the docs."), false);
});

check("offers, questions, and closing lines are not retried", () => {
  assert.equal(looksUnfinished("I'll be happy to help further."), false);
  assert.equal(looksUnfinished("Let me know if you want me to rerun it."), false);
  assert.equal(looksUnfinished("Which file should I rerun?"), false);
  assert.equal(looksUnfinished("Feel free to ask me to check another value."), false);
});

check("empty, non-string, and overlong replies are refused", () => {
  assert.equal(looksUnfinished(""), false);
  assert.equal(looksUnfinished("   "), false);
  assert.equal(looksUnfinished(undefined), false);
  assert.equal(looksUnfinished("x".repeat(900) + " I'll rerun it."), false);
});

check("the gate needs a done, tool-using turn inside the budget", () => {
  const text = "I'll rerun that part to verify it.";
  assert.equal(
    shouldContinue({ status: "done", text, usedTools: true, continuations: 0, isContinuation: false }),
    true
  );
  assert.equal(
    shouldContinue({
      status: "done",
      text,
      usedTools: true,
      continuations: MAX_CONTINUATIONS,
      isContinuation: false,
    }),
    false
  );
  assert.equal(
    shouldContinue({ status: "done", text, usedTools: false, continuations: 0, isContinuation: false }),
    false
  );
  assert.equal(
    shouldContinue({ status: "unanswered", text, usedTools: true, continuations: 0, isContinuation: false }),
    false
  );
  assert.equal(
    shouldContinue({ status: "done", text: "All done.", usedTools: true, continuations: 0, isContinuation: false }),
    false
  );
});

check("a silent continuation that used tools gets one report pass", () => {
  assert.equal(
    shouldContinue({ status: "done", text: "   ", usedTools: true, continuations: 1, isContinuation: true }),
    true
  );
  assert.equal(
    shouldContinue({ status: "done", text: "", usedTools: false, continuations: 1, isContinuation: true }),
    false
  );
  assert.equal(
    shouldContinue({ status: "done", text: "", usedTools: true, continuations: 0, isContinuation: false }),
    false
  );
  assert.equal(
    shouldContinue({
      status: "done",
      text: "",
      usedTools: true,
      continuations: MAX_CONTINUATIONS,
      isContinuation: true,
    }),
    false
  );
});

check("the instruction asks for a report when the turn was silent", () => {
  assert.match(continuationInstruction(""), /without a reply/);
  assert.match(continuationInstruction(""), /Write the answer/);
  assert.match(continuationInstruction("I'll rerun it."), /Take the next step now/);
  assert.match(continuationInstruction("I'll rerun it."), /stop calling tools once you have enough/);
});

check("the fallback is honest", () => {
  assert.match(NO_SUMMARY, /no final summary/);
  assert.match(NO_SUMMARY, /tool output above/);
});

check("the nudge tells the model to act, not restate", () => {
  assert.match(CONTINUATION_NUDGE, /continue the task now/i);
  assert.match(CONTINUATION_NUDGE, /call the appropriate tool/i);
  assert.match(CONTINUATION_NUDGE, /do not restate the promise/i);
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`continuation: ${failures.length} failed`);
  process.exit(1);
}
