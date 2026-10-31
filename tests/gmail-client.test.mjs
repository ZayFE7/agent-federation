// Offline contract tests for src/gmail-client.ts.
//
// No network and no real Gmail token. Every call goes through a fake fetch that
// records the URL, method, headers, and body and answers with fixture JSON, so
// request shapes and response parsing are both pinned. Plain Node:
// `node tests/gmail-client.test.mjs`.

import assert from "node:assert/strict";
import {
  GmailApiError,
  GmailAuthError,
  GmailClient,
  buildMimeMessage,
  capText,
  decodeBase64Url,
  encodeBase64Url,
  gmailLabelIdsForOperation,
  parseThreadPayload,
} from "../src/gmail-client.ts";

const TOKEN = "test-access-token-ya29.secret-value";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

const failures = [];
let checks = 0;

async function check(name, fn) {
  checks += 1;
  try {
    await fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

function b64url(value, encoding = "utf8") {
  return Buffer.from(value, encoding).toString("base64url");
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function fakeFetch(handler) {
  const requests = [];
  const fn = async (url, init = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
    const request = {
      url: String(url),
      method: init.method ?? "GET",
      headers,
      body: init.body,
      json() {
        return JSON.parse(this.body);
      },
    };
    requests.push(request);
    return handler(request, requests.length - 1);
  };
  return { fn, requests };
}

function clientWith(handler) {
  const fake = fakeFetch(handler);
  return { client: new GmailClient({ fetch: fake.fn }), requests: fake.requests };
}

async function captureError(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return null;
}

function metadataThread(overrides = {}) {
  const {
    id = "thread-1",
    labels = ["INBOX", "UNREAD"],
    from = "Alice Example <alice@example.com>",
    to = "me@example.com",
    subject = "Quarterly plan",
    date = "Mon, 26 Oct 2026 10:00:00 +0000",
    snippet = "The plan is attached",
    messageCount = 1,
  } = overrides;
  return {
    id,
    snippet,
    labelIds: labels,
    messages: Array.from({ length: messageCount }, (_, index) => ({
      id: `${id}-message-${index}`,
      threadId: id,
      labelIds: labels,
      payload: {
        headers: [
          { name: "From", value: from },
          { name: "To", value: to },
          { name: "Subject", value: subject },
          { name: "Date", value: date },
        ],
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// Base64url and caps
// ---------------------------------------------------------------------------

await check("base64url helpers round-trip unicode and match standard base64url", () => {
  const text = "héllo 🌍 — gmail";
  const encoded = encodeBase64Url(text);
  assert.equal(encoded, b64url(text));
  assert.equal(decodeBase64Url(encoded), text);
  assert.ok(!/[+/=]/.test(encoded));

  const padded = Buffer.from("hello", "utf8").toString("base64");
  assert.equal(decodeBase64Url(padded), "hello");
  assert.equal(decodeBase64Url(b64url("hello")), "hello");
});

await check("capText preserves short text and marks a truncation with both lengths", () => {
  assert.equal(capText("short", 20), "short");
  const capped = capText("x".repeat(100), 10);
  assert.ok(capped.startsWith("xxxxxxxxxx"));
  assert.match(capped, /\[truncated:/);
  assert.match(capped, /first 10 of 100 characters/);
});

// ---------------------------------------------------------------------------
// MIME build
// ---------------------------------------------------------------------------

await check("MIME builder writes address and identity headers for a plain body", () => {
  const raw = buildMimeMessage({
    to: "bob@example.com",
    cc: "carol@example.com",
    bcc: "dave@example.com",
    from: "me@example.com",
    subject: "Hello there",
    body: "Plain body",
  });
  assert.equal(typeof raw, "string");
  assert.ok(!/[+/=]/.test(raw), "raw must be unpadded base64url");

  const mime = decodeBase64Url(raw);
  assert.match(mime, /^To: bob@example\.com\r\n/);
  assert.match(mime, /\r\nCc: carol@example\.com\r\n/);
  assert.match(mime, /\r\nBcc: dave@example\.com\r\n/);
  assert.match(mime, /\r\nFrom: me@example\.com\r\n/);
  assert.match(mime, /\r\nSubject: Hello there\r\n/);
  assert.match(mime, /\r\nMIME-Version: 1\.0\r\n/);
  assert.match(mime, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.equal(
    (mime.match(/Content-Type: text\/plain/g) ?? []).length,
    1,
    "the top-level type must not be duplicated inside the body"
  );
  assert.ok(mime.includes(`\r\n\r\n${Buffer.from("Plain body", "utf8").toString("base64")}`));
});

await check("MIME header values cannot inject extra headers", () => {
  const mime = decodeBase64Url(
    buildMimeMessage({
      to: "bob@example.com",
      subject: "Hi\r\nBcc: sneaky@example.com",
      body: "x",
    })
  );
  assert.ok(!mime.split("\r\n").some((line) => line.startsWith("Bcc:")));
  assert.match(mime, /Subject: Hi Bcc: sneaky@example\.com/);
});

await check("MIME builder makes a text+html multipart/alternative with the caller boundary", () => {
  const mime = decodeBase64Url(
    buildMimeMessage(
      {
        to: "bob@example.com",
        subject: "Both",
        body: "Plain version",
        html: "<p>HTML version</p>",
      },
      "fixed-boundary"
    )
  );
  assert.match(mime, /Content-Type: multipart\/alternative; boundary="fixed-boundary"/);
  assert.ok(mime.includes("--fixed-boundary\r\n"));
  assert.ok(mime.includes("--fixed-boundary--"));
  assert.equal((mime.match(/Content-Type: text\/plain/g) ?? []).length, 1);
  assert.equal((mime.match(/Content-Type: text\/html/g) ?? []).length, 1);
  assert.ok(mime.includes(Buffer.from("Plain version", "utf8").toString("base64")));
  assert.ok(mime.includes(Buffer.from("<p>HTML version</p>", "utf8").toString("base64")));
});

await check("MIME builder wraps text+html and a base64 attachment in multipart/mixed", () => {
  const mime = decodeBase64Url(
    buildMimeMessage(
      {
        to: "bob@example.com",
        subject: "Report",
        body: "See attached",
        html: "<p>See attached</p>",
        attachments: [
          {
            filename: "report.pdf",
            mimeType: "application/pdf",
            content: Buffer.from("PDF-CONTENT", "utf8").toString("base64"),
          },
        ],
      },
      "outer-boundary"
    )
  );
  assert.match(mime, /Content-Type: multipart\/mixed; boundary="outer-boundary"/);
  assert.match(mime, /Content-Type: multipart\/alternative; boundary="outer-boundary_alt"/);
  assert.match(mime, /Content-Type: application\/pdf; name="report\.pdf"/);
  assert.match(mime, /Content-Disposition: attachment; filename="report\.pdf"/);
  assert.ok(mime.includes(Buffer.from("PDF-CONTENT", "utf8").toString("base64")));
  assert.ok(mime.includes("--outer-boundary--"));
});

await check("MIME builder accepts raw attachment bytes and rejects over-limit counts and bytes", () => {
  const mime = decodeBase64Url(
    buildMimeMessage({
      to: "bob@example.com",
      body: "x",
      attachments: [
        {
          filename: "bytes.bin",
          mimeType: "application/octet-stream",
          bytes: new TextEncoder().encode("RAW-BYTES"),
        },
      ],
    })
  );
  assert.ok(mime.includes(Buffer.from("RAW-BYTES", "utf8").toString("base64")));
  assert.equal(
    (mime.match(/Content-Type: text\/plain/g) ?? []).length,
    1,
    "a text body nested in multipart/mixed carries one Content-Type"
  );

  const tooMany = Array.from({ length: 11 }, (_, index) => ({
    filename: `file-${index}.txt`,
    content: "eA==",
  }));
  assert.throws(
    () => buildMimeMessage({ to: "bob@example.com", body: "x", attachments: tooMany }),
    /too many attachments/i
  );

  assert.throws(
    () =>
      buildMimeMessage({
        to: "bob@example.com",
        body: "x",
        attachments: [
          {
            filename: "huge.bin",
            mimeType: "application/octet-stream",
            bytes: new Uint8Array(10 * 1024 * 1024 + 1),
          },
        ],
      }),
    /too large/i
  );
});

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

await check("parseThreadPayload walks nested alternatives and records attachment metadata", () => {
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: b64url("plain body") } },
          { mimeType: "text/html", body: { data: b64url("<p>html body</p>") } },
        ],
      },
      {
        mimeType: "image/png",
        filename: "photo.png",
        body: { attachmentId: "att-1", size: 2048 },
      },
      {
        mimeType: "text/plain",
        filename: "notes.txt",
        body: { attachmentId: "att-2", size: 12 },
      },
    ],
  };
  const parsed = parseThreadPayload(payload);
  assert.equal(parsed.text, "plain body");
  assert.equal(parsed.html, "<p>html body</p>");
  assert.deepEqual(parsed.attachments, [
    { id: "att-1", filename: "photo.png", mimeType: "image/png", size: 2048 },
    { id: "att-2", filename: "notes.txt", mimeType: "text/plain", size: 12 },
  ]);
});

// ---------------------------------------------------------------------------
// searchThreads
// ---------------------------------------------------------------------------

await check("searchThreads calls threads.list with q/maxResults and metadata gets with four headers", async () => {
  const { client, requests } = clientWith((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/gmail/v1/users/me/threads") {
      return jsonResponse({ threads: [{ id: "thread-1" }, { id: "thread-2" }] });
    }
    if (url.pathname === "/gmail/v1/users/me/threads/thread-1") {
      return jsonResponse(metadataThread({ id: "thread-1", messageCount: 3 }));
    }
    if (url.pathname === "/gmail/v1/users/me/threads/thread-2") {
      return jsonResponse(
        metadataThread({
          id: "thread-2",
          labels: ["INBOX", "STARRED", "UNREAD"],
          from: "Bob <bob@example.com>",
          subject: "Second subject",
          date: "Tue, 27 Oct 2026 11:30:00 +0000",
          snippet: "Second snippet",
          messageCount: 2,
        })
      );
    }
    throw new Error(`unexpected URL ${request.url}`);
  });

  const summaries = await client.searchThreads(
    TOKEN,
    "me@example.com",
    "is:unread from:alice",
    50
  );

  assert.equal(requests.length, 3);
  const listUrl = new URL(requests[0].url);
  assert.equal(listUrl.pathname, "/gmail/v1/users/me/threads");
  assert.equal(listUrl.searchParams.get("q"), "is:unread from:alice");
  assert.equal(listUrl.searchParams.get("maxResults"), "20");

  const metadataUrl = new URL(requests[1].url);
  assert.equal(metadataUrl.searchParams.get("format"), "metadata");
  assert.deepEqual(metadataUrl.searchParams.getAll("metadataHeaders"), [
    "From",
    "To",
    "Subject",
    "Date",
  ]);
  assert.equal(requests[1].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(requests[1].headers.accept, "application/json");
  assert.equal(requests[1].method, "GET");

  assert.deepEqual(summaries, [
    {
      account: "me@example.com",
      id: "thread-1",
      subject: "Quarterly plan",
      from: "Alice Example <alice@example.com>",
      date: "Mon, 26 Oct 2026 10:00:00 +0000",
      snippet: "The plan is attached",
      labels: ["INBOX", "UNREAD"],
      unread: true,
      messages: 3,
    },
    {
      account: "me@example.com",
      id: "thread-2",
      subject: "Second subject",
      from: "Bob <bob@example.com>",
      date: "Tue, 27 Oct 2026 11:30:00 +0000",
      snippet: "Second snippet",
      labels: ["INBOX", "STARRED", "UNREAD"],
      unread: true,
      messages: 2,
    },
  ]);
});

await check("searchThreads caps the result count and handles empty thread lists", async () => {
  const { client, requests } = clientWith((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/gmail/v1/users/me/threads") {
      return jsonResponse({
        threads: [{ id: "thread-1" }, { id: "thread-2" }, { id: "thread-3" }],
      });
    }
    return jsonResponse(metadataThread({ id: url.pathname.split("/").pop(), labels: ["INBOX"] }));
  });

  const summaries = await client.searchThreads(TOKEN, "me@example.com", "", 2);
  assert.equal(new URL(requests[0].url).searchParams.get("maxResults"), "2");
  assert.equal(summaries.length, 2);
  assert.equal(requests.length, 3, "only two metadata gets");

  const empty = clientWith(() => jsonResponse({ resultSizeEstimate: 0 }));
  assert.deepEqual(await empty.client.searchThreads(TOKEN, "me@example.com", "nothing", 5), []);
  assert.equal(empty.requests.length, 1);
});

// ---------------------------------------------------------------------------
// readThread
// ---------------------------------------------------------------------------

function fullThreadFixture() {
  return {
    id: "thread-9",
    labelIds: ["INBOX", "UNREAD", "Label_42"],
    messages: [
      {
        id: "message-1",
        threadId: "thread-9",
        labelIds: ["INBOX", "UNREAD", "Label_42"],
        payload: {
          mimeType: "multipart/mixed",
          headers: [
            { name: "From", value: "Alice <alice@example.com>" },
            { name: "To", value: "me@example.com" },
            { name: "Cc", value: "team@example.com" },
            { name: "Subject", value: "Project update" },
            { name: "Date", value: "Mon, 26 Oct 2026 10:00:00 +0000" },
          ],
          parts: [
            {
              mimeType: "multipart/alternative",
              parts: [
                { mimeType: "text/plain", body: { data: b64url("Hello plain") } },
                {
                  mimeType: "text/html",
                  body: { data: b64url("<p>Hello <strong>HTML</strong></p>") },
                },
              ],
            },
            {
              mimeType: "application/pdf",
              filename: "plan.pdf",
              body: { attachmentId: "attachment-1", size: 9999 },
            },
          ],
        },
      },
      {
        id: "message-2",
        threadId: "thread-9",
        labelIds: ["INBOX"],
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "Bob <bob@example.com>" },
            { name: "To", value: "me@example.com" },
            { name: "Subject", value: "Re: Project update" },
            { name: "Date", value: "Mon, 26 Oct 2026 12:00:00 +0000" },
          ],
          body: { data: b64url("Second plain") },
        },
      },
    ],
  };
}

await check("readThread fetches format=full and parses headers, bodies, labels, attachments", async () => {
  const { client, requests } = clientWith((request) => {
    const url = new URL(request.url);
    assert.equal(url.pathname, "/gmail/v1/users/me/threads/thread-9");
    assert.equal(url.searchParams.get("format"), "full");
    return jsonResponse(fullThreadFixture());
  });

  const view = await client.readThread(TOKEN, "me@example.com", "thread-9");
  assert.equal(requests.length, 1);
  assert.equal(view.account, "me@example.com");
  assert.equal(view.id, "thread-9");
  assert.equal(view.subject, "Project update");
  assert.deepEqual(view.labels, ["INBOX", "UNREAD", "Label_42"]);
  assert.equal(view.messages.length, 2);

  const first = view.messages[0];
  assert.equal(first.id, "message-1");
  assert.equal(first.threadId, "thread-9");
  assert.equal(first.from, "Alice <alice@example.com>");
  assert.equal(first.to, "me@example.com");
  assert.equal(first.cc, "team@example.com");
  assert.equal(first.subject, "Project update");
  assert.equal(first.date, "Mon, 26 Oct 2026 10:00:00 +0000");
  assert.equal(first.bodyText, "Hello plain");
  assert.equal(first.bodyHtml, "<p>Hello <strong>HTML</strong></p>");
  assert.deepEqual(first.labels, ["INBOX", "UNREAD", "Label_42"]);
  assert.deepEqual(first.attachments, [
    { id: "attachment-1", filename: "plan.pdf", mimeType: "application/pdf", size: 9999 },
  ]);

  const second = view.messages[1];
  assert.equal(second.bodyText, "Second plain");
  assert.equal(second.bodyHtml, undefined);
  assert.deepEqual(second.attachments, []);
});

await check("readThread caps bodyText at 60k and html at 40k with markers", async () => {
  const longText = "a".repeat(70_000);
  const longHtml = "b".repeat(50_000);
  const { client } = clientWith(() =>
    jsonResponse({
      id: "thread-long",
      labelIds: ["INBOX"],
      messages: [
        {
          id: "message-long",
          threadId: "thread-long",
          labelIds: ["INBOX"],
          payload: {
            mimeType: "multipart/alternative",
            headers: [{ name: "Subject", value: "Long" }],
            parts: [
              { mimeType: "text/plain", body: { data: b64url(longText) } },
              { mimeType: "text/html", body: { data: b64url(longHtml) } },
            ],
          },
        },
      ],
    })
  );

  const view = await client.readThread(TOKEN, "me@example.com", "thread-long");
  const message = view.messages[0];
  assert.ok(message.bodyText.length < longText.length);
  assert.match(message.bodyText, /\[truncated: showing first 60000 of 70000 characters\]/);
  assert.ok(message.bodyHtml.length < longHtml.length);
  assert.match(message.bodyHtml, /\[truncated: showing first 40000 of 50000 characters\]/);
});

await check("readThread falls back to HTML text when no text/plain part exists", async () => {
  const { client } = clientWith(() =>
    jsonResponse({
      id: "thread-html",
      labelIds: ["INBOX"],
      messages: [
        {
          id: "message-html",
          threadId: "thread-html",
          labelIds: ["INBOX"],
          payload: {
            mimeType: "text/html",
            headers: [{ name: "Subject", value: "HTML only" }],
            body: { data: b64url("<p>Hello &amp; welcome</p>") },
          },
        },
      ],
    })
  );
  const view = await client.readThread(TOKEN, "me@example.com", "thread-html");
  assert.equal(view.messages[0].bodyText, "Hello & welcome");
  assert.equal(view.messages[0].bodyHtml, "<p>Hello &amp; welcome</p>");
});

// ---------------------------------------------------------------------------
// Labels and thread management
// ---------------------------------------------------------------------------

await check("listLabels maps labels.list without reordering", async () => {
  const { client, requests } = clientWith(() =>
    jsonResponse({
      labels: [
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "Label_7", name: "Clients", type: "user" },
      ],
    })
  );
  const labels = await client.listLabels(TOKEN);
  assert.equal(new URL(requests[0].url).pathname, "/gmail/v1/users/me/labels");
  assert.deepEqual(labels, [
    { id: "INBOX", name: "INBOX", type: "system" },
    { id: "Label_7", name: "Clients", type: "user" },
  ]);
});

await check("modifyThread, trash, untrash, and delete issue the expected requests", async () => {
  const { client, requests } = clientWith((request) =>
    request.method === "DELETE"
      ? new Response(null, { status: 204 })
      : jsonResponse({ id: "thread-1" })
  );

  await client.modifyThread(TOKEN, "thread-1", ["STARRED", "Label_2"], ["UNREAD"]);
  await client.trashThread(TOKEN, "thread-1");
  await client.untrashThread(TOKEN, "thread-1");
  await client.deleteThread(TOKEN, "thread-1");

  assert.equal(requests.length, 4);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers["content-type"], "application/json");
  assert.equal(requests[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(new URL(requests[0].url).pathname, "/gmail/v1/users/me/threads/thread-1/modify");
  assert.deepEqual(requests[0].json(), {
    addLabelIds: ["STARRED", "Label_2"],
    removeLabelIds: ["UNREAD"],
  });

  assert.equal(requests[1].method, "POST");
  assert.equal(new URL(requests[1].url).pathname, "/gmail/v1/users/me/threads/thread-1/trash");
  assert.equal(requests[2].method, "POST");
  assert.equal(new URL(requests[2].url).pathname, "/gmail/v1/users/me/threads/thread-1/untrash");
  assert.equal(requests[3].method, "DELETE");
  assert.equal(new URL(requests[3].url).pathname, "/gmail/v1/users/me/threads/thread-1");
});

await check("gmailLabelIdsForOperation maps archive/read/star/spam and explicit labels", () => {
  assert.deepEqual(gmailLabelIdsForOperation("archive"), {
    addLabelIds: [],
    removeLabelIds: ["INBOX"],
  });
  assert.deepEqual(gmailLabelIdsForOperation("unarchive"), {
    addLabelIds: ["INBOX"],
    removeLabelIds: [],
  });
  assert.deepEqual(gmailLabelIdsForOperation("mark_read"), {
    addLabelIds: [],
    removeLabelIds: ["UNREAD"],
  });
  assert.deepEqual(gmailLabelIdsForOperation("mark_unread"), {
    addLabelIds: ["UNREAD"],
    removeLabelIds: [],
  });
  assert.deepEqual(gmailLabelIdsForOperation("star"), {
    addLabelIds: ["STARRED"],
    removeLabelIds: [],
  });
  assert.deepEqual(gmailLabelIdsForOperation("unstar"), {
    addLabelIds: [],
    removeLabelIds: ["STARRED"],
  });
  assert.deepEqual(gmailLabelIdsForOperation("spam"), {
    addLabelIds: ["SPAM"],
    removeLabelIds: ["INBOX"],
  });
  assert.deepEqual(gmailLabelIdsForOperation("not_spam"), {
    addLabelIds: ["INBOX"],
    removeLabelIds: ["SPAM"],
  });
  assert.deepEqual(gmailLabelIdsForOperation("apply_label", ["Label_1", "Label_1"]), {
    addLabelIds: ["Label_1"],
    removeLabelIds: [],
  });
  assert.deepEqual(gmailLabelIdsForOperation("remove_label", ["Label_2"]), {
    addLabelIds: [],
    removeLabelIds: ["Label_2"],
  });
  assert.deepEqual(gmailLabelIdsForOperation("trash"), {
    addLabelIds: [],
    removeLabelIds: [],
  });
});

// ---------------------------------------------------------------------------
// Drafts, sends, replies
// ---------------------------------------------------------------------------

await check("createDraft posts a MIME raw message under drafts.create", async () => {
  const { client, requests } = clientWith(() =>
    jsonResponse({ id: "draft-1", message: { id: "message-1", threadId: "thread-1" } })
  );

  const created = await client.createDraft(TOKEN, {
    to: "bob@example.com",
    subject: "Draft subject",
    body: "Draft body",
  });

  assert.deepEqual(created, { id: "draft-1" });
  assert.equal(new URL(requests[0].url).pathname, "/gmail/v1/users/me/drafts");
  assert.equal(requests[0].method, "POST");
  const body = requests[0].json();
  assert.equal(typeof body.message.raw, "string");
  const mime = decodeBase64Url(body.message.raw);
  assert.match(mime, /To: bob@example\.com/);
  assert.match(mime, /Subject: Draft subject/);
  assert.ok(mime.includes(Buffer.from("Draft body", "utf8").toString("base64")));
  assert.equal(body.message.threadId, undefined);
});

await check("sendMessage posts only raw and returns id plus threadId", async () => {
  const { client, requests } = clientWith(() =>
    jsonResponse({ id: "message-1", threadId: "thread-1", labelIds: ["SENT"] })
  );

  const sent = await client.sendMessage(TOKEN, {
    to: "bob@example.com",
    subject: "Sent subject",
    html: "<p>Sent HTML</p>",
  });

  assert.deepEqual(sent, { id: "message-1", threadId: "thread-1" });
  assert.equal(new URL(requests[0].url).pathname, "/gmail/v1/users/me/messages/send");
  assert.equal(requests[0].method, "POST");
  assert.deepEqual(Object.keys(requests[0].json()), ["raw"]);
  const mime = decodeBase64Url(requests[0].json().raw);
  assert.match(mime, /Content-Type: text\/html; charset="UTF-8"/);
  assert.ok(mime.includes(Buffer.from("<p>Sent HTML</p>", "utf8").toString("base64")));
});

await check("replyMessage sends threadId and writes In-Reply-To and References", async () => {
  const { client, requests } = clientWith(() =>
    jsonResponse({ id: "message-2", threadId: "thread-9" })
  );

  const sent = await client.replyMessage(TOKEN, {
    to: "alice@example.com",
    subject: "Re: Project update",
    body: "Reply body",
    threadId: "thread-9",
    inReplyTo: "<message-1@example.com>",
    references: ["<root@example.com>", "<message-1@example.com>"],
  });

  assert.deepEqual(sent, { id: "message-2", threadId: "thread-9" });
  const body = requests[0].json();
  assert.equal(body.threadId, "thread-9");
  const mime = decodeBase64Url(body.raw);
  assert.match(mime, /In-Reply-To: <message-1@example\.com>/);
  assert.match(mime, /References: <root@example\.com> <message-1@example\.com>/);
});

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

await check("getAttachment downloads bytes when filename and MIME type are supplied", async () => {
  const { client, requests } = clientWith(() =>
    jsonResponse({ size: 7, data: b64url("PAYLOAD") })
  );

  const file = await client.getAttachment(
    TOKEN,
    "message-1",
    "attachment-1",
    "report.pdf",
    "application/pdf"
  );

  assert.equal(requests.length, 1, "no metadata lookup needed");
  assert.equal(
    new URL(requests[0].url).pathname,
    "/gmail/v1/users/me/messages/message-1/attachments/attachment-1"
  );
  assert.equal(file.filename, "report.pdf");
  assert.equal(file.mimeType, "application/pdf");
  assert.equal(Buffer.from(file.bytes).toString("utf8"), "PAYLOAD");
});

await check("getAttachment looks up filename and MIME type from message metadata", async () => {
  const { client, requests } = clientWith((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/gmail/v1/users/me/messages/message-1") {
      assert.equal(url.searchParams.get("format"), "full");
      return jsonResponse({
        id: "message-1",
        payload: {
          mimeType: "multipart/mixed",
          parts: [
            { mimeType: "text/plain", body: { data: b64url("body") } },
            {
              mimeType: "image/png",
              filename: "photo.png",
              body: { attachmentId: "attachment-9", size: 4 },
            },
          ],
        },
      });
    }
    assert.equal(
      url.pathname,
      "/gmail/v1/users/me/messages/message-1/attachments/attachment-9"
    );
    return jsonResponse({ size: 4, data: b64url("PNG!") });
  });

  const file = await client.getAttachment(TOKEN, "message-1", "attachment-9");
  assert.equal(requests.length, 2);
  assert.equal(file.filename, "photo.png");
  assert.equal(file.mimeType, "image/png");
  assert.equal(Buffer.from(file.bytes).toString("utf8"), "PNG!");
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

await check("401 throws GmailAuthError with no token in message or stack", async () => {
  const { client } = clientWith(() =>
    jsonResponse(
      { error: { code: 401, message: `Invalid Credentials for ${TOKEN}`, status: "UNAUTHENTICATED" } },
      401
    )
  );

  const error = await captureError(() => client.listLabels(TOKEN));
  assert.ok(error instanceof GmailAuthError);
  assert.ok(error instanceof GmailApiError);
  assert.equal(error.status, 401);
  assert.match(error.message, /401/);
  assert.match(error.message, /reconnect/i);
  assert.ok(!error.message.includes(TOKEN));
  assert.ok(!String(error.stack).includes(TOKEN));
});

await check("403 throws GmailApiError with status and a readable permission message", async () => {
  const { client } = clientWith(() =>
    jsonResponse(
      {
        error: {
          code: 403,
          message: "Insufficient Permission",
          status: "PERMISSION_DENIED",
          errors: [{ reason: "insufficientPermissions", message: "Insufficient Permission" }],
        },
      },
      403
    )
  );

  const error = await captureError(() => client.readThread(TOKEN, "me@example.com", "t1"));
  assert.ok(error instanceof GmailApiError);
  assert.ok(!(error instanceof GmailAuthError));
  assert.equal(error.status, 403);
  assert.equal(error.reason, "insufficientPermissions");
  assert.match(error.message, /403/);
  assert.match(error.message, /insufficientPermissions/);
  assert.ok(!error.message.includes(TOKEN));
});

await check("429 exposes status and Retry-After without leaking the token", async () => {
  const { client } = clientWith(() =>
    jsonResponse(
      {
        error: {
          code: 429,
          message: "User-rate limit exceeded",
          errors: [{ reason: "rateLimitExceeded", message: "User-rate limit exceeded" }],
        },
      },
      429,
      { "retry-after": "23" }
    )
  );

  const error = await captureError(() => client.listLabels(TOKEN));
  assert.ok(error instanceof GmailApiError);
  assert.equal(error.status, 429);
  assert.equal(error.retryAfter, 23);
  assert.match(error.message, /429/);
  assert.match(error.message, /23/);
  assert.match(error.message, /Retry-After/);
  assert.ok(!error.message.includes(TOKEN));
});

await check("other errors are redacted and network failures stay typed", async () => {
  const { client } = clientWith(() =>
    jsonResponse(
      {
        error: {
          message: `backend failed for ${TOKEN} with Bearer ${TOKEN}`,
          status: "INTERNAL",
        },
      },
      500
    )
  );
  const error = await captureError(() => client.listLabels(TOKEN));
  assert.ok(error instanceof GmailApiError);
  assert.equal(error.status, 500);
  assert.match(error.message, /500/);
  assert.ok(!error.message.includes(TOKEN));
  assert.match(error.message, /redacted/);

  const network = clientWith(() => {
    throw new Error(`socket closed for ${TOKEN}`);
  });
  const networkError = await captureError(() => network.client.listLabels(TOKEN));
  assert.ok(networkError instanceof GmailApiError);
  assert.equal(networkError.status, 0);
  assert.ok(!networkError.message.includes(TOKEN));
});

await check("client tolerates minimal fetch doubles that expose only json()", async () => {
  const success = clientWith(() => ({
    ok: true,
    status: 200,
    json: async () => ({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }] }),
  }));
  assert.deepEqual(await success.client.listLabels(TOKEN), [
    { id: "INBOX", name: "INBOX", type: "system" },
  ]);

  const failure = clientWith(() => ({
    ok: false,
    status: 403,
    json: async () => ({
      error: { message: "Denied", errors: [{ reason: "forbidden" }] },
    }),
  }));
  const error = await captureError(() => failure.client.listLabels(TOKEN));
  assert.ok(error instanceof GmailApiError);
  assert.equal(error.status, 403);
  assert.match(error.message, /403/);
  assert.match(error.message, /forbidden/);
});

if (failures.length > 0) {
  console.error(`${failures.length} of ${checks} checks failed:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`${checks} checks passed`);
