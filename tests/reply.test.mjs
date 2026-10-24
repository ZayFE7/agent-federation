// Unit tests for src/reply.ts: one harness prompt result projected onto the
// console's AgentReply envelope. Plain Node: `node tests/reply.test.mjs`.
// Silent on success (exit 0).

import assert from "node:assert/strict";
import { messageText, replyFrom } from "../src/reply.ts";

const failures = [];

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

const user = (text) => ({ role: "user", parts: [{ type: "text", text }] });
const assistant = (...parts) => ({ role: "assistant", parts });

check("one text part and two tool parts yield the text and two cards", () => {
  const result = replyFrom({
    status: "done",
    text: "Done",
    messages: [
      user("build it"),
      assistant(
        { type: "text", text: "Done" },
        {
          type: "tool-exec",
          toolCallId: "t1",
          state: "output-available",
          input: { cmd: "mkdir app" },
          output: "ok",
        },
        {
          type: "tool-lookup_online",
          toolCallId: "t2",
          state: "output-available",
          input: { query: "habits" },
          output: "3 results",
        }
      ),
    ],
  });
  assert.equal(result.reply, "Done");
  assert.equal(result.tools.length, 2);
  assert.deepEqual(
    result.tools.map((t) => t.name),
    ["exec", "lookup_online"]
  );
  assert.equal(result.tools[0].cmd, "mkdir app");
  assert.equal(result.tools[0].ok, true);
  assert.equal(result.pending, undefined);
});

check("a parked exec yields pending with the command and the real toolCallId", () => {
  const result = replyFrom({
    status: "done",
    messages: [
      user("delete the temp dir"),
      assistant(
        { type: "text", text: "I need your OK." },
        {
          type: "tool-exec",
          toolCallId: "tc9",
          state: "approval-requested",
          input: { cmd: "rm -rf /tmp/holdcheck" },
          approval: { id: "approval:tc9" },
        }
      ),
    ],
  });
  assert.deepEqual(result.pending, {
    toolCallId: "tc9",
    name: "exec",
    cmd: "rm -rf /tmp/holdcheck",
  });
  assert.equal(result.state, "approve");
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].ok, false, "a parked call has not produced an output");
});

check("a failed tool part yields ok: false", () => {
  const result = replyFrom({
    status: "done",
    messages: [
      user("run it"),
      assistant(
        { type: "text", text: "It failed." },
        {
          type: "tool-exec",
          toolCallId: "t3",
          state: "output-error",
          input: { cmd: "false" },
          errorText: "exit 1",
        }
      ),
    ],
  });
  assert.equal(result.tools[0].ok, false);
  assert.equal(result.state, "error");
});

check("an empty assistant message produces a non-empty explanation", () => {
  const result = replyFrom({
    status: "done",
    messages: [user("hi"), assistant()],
  });
  assert.equal(typeof result.reply, "string");
  assert.ok(result.reply.length > 0, "the console hides empty replies");
  assert.match(result.reply, /without producing a text reply/);
});

check("an unanswered turn explains that the agent stopped", () => {
  const result = replyFrom({
    status: "unanswered",
    reason: "interrupted",
    messages: [user("hi"), assistant()],
  });
  assert.match(result.reply, /stopped before writing a reply/);
  assert.match(result.reply, /interrupted/);
  assert.equal(result.state, "error");
});

check("tool parts from earlier turns are excluded from this reply", () => {
  const result = replyFrom({
    status: "done",
    messages: [
      user("first"),
      assistant({
        type: "tool-exec",
        toolCallId: "old",
        state: "output-available",
        input: { cmd: "ls" },
        output: "a.txt",
      }),
      user("second"),
      assistant({ type: "text", text: "Answer two" }),
    ],
  });
  assert.equal(result.reply, "Answer two");
  assert.equal(result.tools, undefined, "only the slice after the last user message counts");
  assert.equal(result.state, "idle");
});

check("messageText joins text parts and ignores the rest", () => {
  assert.equal(
    messageText({
      parts: [
        { type: "text", text: "one" },
        { type: "tool-exec" },
        { type: "text", text: "two" },
      ],
    }),
    "one\ntwo"
  );
  assert.equal(messageText(undefined), "");
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`reply: ${failures.length} failed`);
  process.exit(1);
}
