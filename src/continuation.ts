// The loop's completion guard (2026-10-23).
//
// A model can end its turn by announcing the next action instead of taking it:
// "I caught an off-by-one bug, so I'll rerun that part." The harness treats a
// model step with no tool calls as a finished turn, so without this guard the
// loop stops on the promise. `looksUnfinished` is a deliberately narrow
// detector: it only fires on the LAST sentence of a short reply that names a
// future action and an action verb, and it refuses questions, offers, and
// closing pleasantries. The gate in `shouldContinue` also requires that the
// turn used a tool, so ordinary conversation cannot trigger a retry.
//
// Dependency-free on purpose: a plain Node test can execute it, and the DO
// imports it without pulling the SDK into a test process.

/** Hard ceiling on automatic retries per user turn. */
export const MAX_CONTINUATIONS = 2;

/** Words that promise a future action. */
const FUTURE_INTENT =
  /\b(i'?ll|i will|i'?m going to|i am going to|let me|i need to|i have to|next,? i(?:'?ll| will)?|i'?m about to|i'?m \w+ing)\b/i;

/** Verbs that mean there is a real next step to take, including -ing forms. */
const ACTION_VERB =
  /\b(?:run|rerun|re-run|retry|test|verify|check|fix|patch|update|write|read|open|search|look|inspect|try|call|execute|build|create|install|debug|compare|measure|dig|confirm|grab|fetch|pull|download|review)\w*\b/i;

/** A last sentence that states the work is not finished. */
const NOT_YET =
  /\b(have(?:n'?t| not)\b[^.]{0,80}\byet|not yet|still (?:need|have) to|next step is|yet to)\b/i;

/** Offers and pleasantries: a future tense here is social, not a stalled step. */
const OFFER =
  /\b(let me know|feel free|happy to|anything else|keep you posted|update you|let you know)\b/i;

/**
 * True when the reply's final sentence announces an action instead of taking
 * it, or explicitly says the work is not finished yet. Only the last sentence
 * decides, so a "Done" summary earlier cannot hide a stalled last step.
 * Questions are never unfinished (the model is waiting on the user), and an
 * offer ("let me know", "happy to help") is not a promise.
 */
export function looksUnfinished(text: string): boolean {
  const raw = (text ?? "").trim();
  if (!raw || raw.length > 800) return false;
  if (/\?\s*$/.test(raw)) return false;
  const sentences = raw.split(/(?<=[.!?])\s+/);
  const last = (sentences[sentences.length - 1] || raw).slice(-400);
  if (OFFER.test(last)) return false;
  return (FUTURE_INTENT.test(last) && ACTION_VERB.test(last)) || NOT_YET.test(last);
}

/** The gate around the detector: only a finished, tool-using turn within budget. */
export function shouldContinue(input: {
  status: string;
  text: string;
  usedTools: boolean;
  continuations: number;
  isContinuation: boolean;
}): boolean {
  if (input.status !== "done" || !input.usedTools) return false;
  if (input.continuations >= MAX_CONTINUATIONS) return false;
  // A continuation that used tools and then said nothing has not answered:
  // that is the silent-stop case, and one more pass can ask for the report.
  if (input.isContinuation && input.text.trim() === "") return true;
  return looksUnfinished(input.text);
}

/** What a reader sees when the last allowed continuation still said nothing. */
export const NO_SUMMARY =
  "The run finished, but the model returned no final summary. The tool output above is the result.";

/** The server-authored next step, chosen by what the previous turn did not do. */
export function continuationInstruction(promise: string): string {
  const tail = (promise ?? "").trim().slice(-240);
  if (!tail) {
    return (
      "Continuation: your last turn used tools but ended without a reply. Write the answer for the user now, using what you found. Do not call another tool unless something essential is missing."
    );
  }
  return (
    "Continuation: your last turn ended with this promise and no action:\n" +
    `"${tail}"\n\n` +
    "Take the next step now using the appropriate tool. Do not restate the promise, do not ask the user anything, and stop calling tools once you have enough to answer the user in plain text."
  );
}

/**
 * The system-prompt nudge for a continuation operation. `continue()` has no
 * user message to carry instruction, so the next model call is told plainly
 * what went wrong and what to do instead.
 */
export const CONTINUATION_NUDGE =
  "Your previous message announced an action but ended the turn without taking it. Continue the task now: call the appropriate tool and carry out the step you described. Do not restate the promise, do not ask the user anything, and do not stop until the task is genuinely complete or you need information only the user can give.";
