// Composio Gmail mapping. A fake executor records the exact tool slugs and
// arguments the adapter sends; no network is involved.

import assert from "node:assert/strict";
import { runComposioGmail } from "../src/composio-gmail.ts";

const ACCOUNT = {
  id: "ca_test123456",
  email: "zay@example.com",
  name: "Zay",
  picture: null,
  is_default: true,
  status: "active",
  scopes: ["https://mail.google.com/"],
  last_error: null,
  last_refresh_at: null,
  created_at: 1,
};

let checks = 0;
const failures = [];
async function check(name, fn) {
  checks++;
  try {
    await fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

function recorder(responses) {
  const calls = [];
  return {
    calls,
    execute: async (accountId, slug, args) => {
      calls.push({ accountId, slug, args });
      const value = responses[slug];
      if (value instanceof Error) throw value;
      return typeof value === "function" ? value(args) : value ?? {};
    },
  };
}

await check("search maps messages to thread summaries and dedupes", async () => {
  const fake = recorder({
    GMAIL_FETCH_EMAILS: {
      messages: [
        {
          threadId: "t1",
          messageId: "m1",
          subject: "Exam schedule",
          sender: "School <school@example.com>",
          messageTimestamp: "2026-10-27T10:00:00Z",
          labelIds: ["INBOX", "UNREAD"],
          preview: { body: "The physics exam is on Monday." },
        },
        {
          threadId: "t1",
          messageId: "m2",
          subject: "Exam schedule",
          sender: "School <school@example.com>",
          labelIds: ["INBOX"],
        },
      ],
    },
  });
  const out = await runComposioGmail(
    { action: "search", query: "exam", limit: 5 },
    [ACCOUNT],
    fake.execute
  );
  assert.match(out, /Exam schedule/);
  assert.match(out, /school@example.com/);
  assert.match(out, /unread/);
  assert.equal(fake.calls[0].slug, "GMAIL_FETCH_EMAILS");
  assert.equal(fake.calls[0].args.max_results, 5);
  assert.equal((out.match(/id t1/g) || []).length, 1);
});

await check("send maps to GMAIL_SEND_EMAIL with the account id", async () => {
  const fake = recorder({ GMAIL_SEND_EMAIL: { id: "msg_1" } });
  const out = await runComposioGmail(
    {
      action: "send",
      to: "friend@example.com",
      cc: "a@example.com, b@example.com",
      subject: "Hello",
      body: "Body text",
    },
    [ACCOUNT],
    fake.execute
  );
  assert.match(out, /Sent from zay@example.com/);
  assert.equal(fake.calls[0].accountId, ACCOUNT.id);
  assert.equal(fake.calls[0].slug, "GMAIL_SEND_EMAIL");
  assert.equal(fake.calls[0].args.recipient_email, "friend@example.com");
  assert.deepEqual(fake.calls[0].args.cc, ["a@example.com", "b@example.com"]);
  assert.equal(fake.calls[0].args.is_html, false);
});

await check("send refuses attachments it cannot upload", async () => {
  const fake = recorder({});
  const out = await runComposioGmail(
    {
      action: "send",
      to: "friend@example.com",
      subject: "Files",
      body: "See attached",
      attachments: ["report.pdf"],
    },
    [ACCOUNT],
    fake.execute
  );
  assert.match(out, /Attachments are not wired/);
  assert.equal(fake.calls.length, 0);
});

await check("reply fetches the thread when to is omitted", async () => {
  const fake = recorder({
    GMAIL_FETCH_MESSAGE_BY_THREAD_ID: {
      messages: [
        {
          messageId: "m1",
          sender: "Friend <friend@example.com>",
          to: "zay@example.com",
          cc: "",
        },
      ],
    },
    GMAIL_REPLY_TO_THREAD: { id: "r1" },
  });
  const out = await runComposioGmail(
    { action: "reply", threadId: "t1", body: "Sounds good" },
    [ACCOUNT],
    fake.execute
  );
  assert.match(out, /Replied in zay@example.com to friend@example.com/);
  const reply = fake.calls.find((call) => call.slug === "GMAIL_REPLY_TO_THREAD");
  assert.equal(reply.args.thread_id, "t1");
  assert.equal(reply.args.recipient_email, "friend@example.com");
});

await check("archive modifies labels on every message in the thread", async () => {
  const fake = recorder({
    GMAIL_FETCH_MESSAGE_BY_THREAD_ID: {
      messages: [{ messageId: "m1" }, { messageId: "m2" }],
    },
    GMAIL_BATCH_MODIFY_MESSAGES: {},
  });
  const out = await runComposioGmail(
    { action: "manage", operation: "archive", threadIds: ["t1"] },
    [ACCOUNT],
    fake.execute
  );
  assert.match(out, /archive on 2 message/);
  const modify = fake.calls.find((call) => call.slug === "GMAIL_BATCH_MODIFY_MESSAGES");
  assert.deepEqual(modify.args.messageIds, ["m1", "m2"]);
  assert.deepEqual(modify.args.removeLabelIds, ["INBOX"]);
  assert.equal(modify.args.userId, "me");
});

await check("permanent delete uses the batch delete tool", async () => {
  const fake = recorder({
    GMAIL_FETCH_MESSAGE_BY_THREAD_ID: { messages: [{ messageId: "m1" }] },
    GMAIL_BATCH_DELETE_MESSAGES: {},
  });
  const out = await runComposioGmail(
    { action: "manage", operation: "delete", threadIds: ["t1"] },
    [ACCOUNT],
    fake.execute
  );
  assert.match(out, /permanently deleted 1 message/);
  const del = fake.calls.find((call) => call.slug === "GMAIL_BATCH_DELETE_MESSAGES");
  assert.deepEqual(del.args.messageIds, ["m1"]);
});

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`composio-gmail: ${failures.length} of ${checks} failed`);
  process.exit(1);
}
console.log(`composio-gmail: ${checks} checks passed`);
