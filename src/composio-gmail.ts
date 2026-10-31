// Gmail actions over Composio tools. The connected account supplies the OAuth
// token; this module maps the console's one `gmail` tool to Composio actions.

import type {
  GmailInput,
  GmailLabelView,
  GmailThreadSummary,
  GoogleAccountView,
} from "./google-types.ts";

export type ComposioGmailExecutor = (
  connectedAccountId: string,
  toolSlug: string,
  args: Record<string, unknown>
) => Promise<Record<string, unknown>>;

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function clean(value: unknown, max = 240): string {
  return str(value).replace(/\s+/g, " ").trim().slice(0, max);
}
function addresses(value: unknown): string[] {
  return str(value)
    .split(/[,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}
function emailOf(value: unknown): string {
  const match = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.exec(str(value));
  return match ? match[0] : "";
}
function labelIdsOf(message: Record<string, unknown>): string[] {
  return arr(message.labelIds).filter((item): item is string => typeof item === "string");
}

function summaryFromMessage(
  account: GoogleAccountView,
  raw: unknown
): GmailThreadSummary {
  const message = rec(raw);
  const labels = labelIdsOf(message);
  const preview = rec(message.preview);
  const text = clean(
    str(preview.body) || str(message.messageText) || str(message.snippet),
    240
  );
  return {
    account: account.email,
    id: str(message.threadId) || str(message.messageId),
    subject: str(message.subject),
    from: str(message.sender),
    date: str(message.messageTimestamp),
    snippet: text,
    labels,
    unread: labels.includes("UNREAD"),
    messages: 1,
  };
}

function summariesRow(row: GmailThreadSummary): string {
  return `- ${row.account} | ${row.subject || "(no subject)"} | ${
    row.from || "unknown sender"
  } | ${row.date || "no date"}${row.unread ? " | unread" : ""}${
    row.labels.length ? ` | labels ${row.labels.join(",")}` : ""
  } | id ${row.id}\n  ${row.snippet.slice(0, 240)}`;
}

async function fetchThread(
  account: GoogleAccountView,
  threadId: string,
  execute: ComposioGmailExecutor
): Promise<Record<string, unknown>> {
  return execute(account.id, "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", {
    user_id: "me",
    thread_id: threadId,
  });
}

async function threadMessageIds(
  account: GoogleAccountView,
  threadId: string,
  execute: ComposioGmailExecutor
): Promise<string[]> {
  const data = await fetchThread(account, threadId, execute);
  return arr(data.messages)
    .map((item) => str(rec(item).messageId))
    .filter(Boolean);
}

async function search(
  input: GmailInput,
  target: GoogleAccountView[],
  execute: ComposioGmailExecutor
): Promise<string> {
  const query = String(input.query ?? "").trim() || "in:inbox";
  const limit = Math.max(1, Math.min(50, Math.floor(Number(input.limit) || 10)));
  const per = Math.max(1, Math.floor(limit / target.length));
  const seen = new Set<string>();
  const rows: GmailThreadSummary[] = [];
  const errors: string[] = [];
  for (const account of target) {
    try {
      const data = await execute(account.id, "GMAIL_FETCH_EMAILS", {
        query,
        max_results: per,
        include_payload: false,
      });
      for (const raw of arr(data.messages)) {
        const summary = summaryFromMessage(account, raw);
        if (!summary.id || seen.has(summary.id)) continue;
        seen.add(summary.id);
        rows.push(summary);
      }
    } catch (err) {
      errors.push(`${account.email}: ${String(err).slice(0, 300)}`);
    }
  }
  const body = rows.length
    ? rows.slice(0, limit).map(summariesRow).join("\n")
    : "No matching mail.";
  return errors.length ? `${body}\n\nSearch errors:\n${errors.join("\n")}` : body;
}

async function read(
  input: GmailInput,
  account: GoogleAccountView,
  execute: ComposioGmailExecutor
): Promise<string> {
  if (!input.threadId) return "read needs a threadId.";
  const data = await fetchThread(account, input.threadId, execute);
  const messages = arr(data.messages).map(rec);
  if (messages.length === 0) return `No messages found in thread ${input.threadId}.`;
  const subject = str(messages[0].subject) || input.threadId;
  const rendered = messages
    .map((message, index) => {
      const attachments = arr(message.attachmentList).map(rec);
      const attachmentText = attachments.length
        ? `\nAttachments:\n${attachments
            .map(
              (attachment) =>
                `- ${str(attachment.filename) || str(attachment.name)} (${str(
                  attachment.mimeType
                )}, ${Number(attachment.size) || 0} bytes, id ${str(
                  attachment.attachmentId
                )})`
            )
            .join("\n")}`
        : "";
      const bodyText = str(message.messageText).slice(0, 12_000);
      return `Message ${index + 1}\nFrom: ${str(message.sender)}\nTo: ${str(
        message.to
      )}\nDate: ${str(message.messageTimestamp)}\nSubject: ${str(
        message.subject
      )}\n\n${bodyText}${attachmentText}`;
    })
    .join("\n\n---\n\n");
  return `Account: ${account.email}\nThread: ${subject}\n\n${rendered}`;
}

async function labels(
  account: GoogleAccountView,
  execute: ComposioGmailExecutor
): Promise<string> {
  const data = await execute(account.id, "GMAIL_LIST_LABELS", { user_id: "me" });
  const rows = arr(data.labels).map(rec) as Array<Partial<GmailLabelView>>;
  return rows.length
    ? rows.map((label) => `${str(label.id)} | ${str(label.name)} | ${str(label.type)}`).join("\n")
    : "No labels.";
}

function composeArgs(
  input: GmailInput,
  isDraft: boolean
): Record<string, unknown> {
  const body = String(input.html ?? input.body ?? "");
  const to = String(input.to ?? "").trim();
  const subject = String(input.subject ?? "").trim();
  const args: Record<string, unknown> = {
    user_id: "me",
    recipient_email: to,
    subject,
    body,
    is_html: Boolean(input.html),
    include_signature: true,
  };
  const cc = addresses(input.cc);
  const bcc = addresses(input.bcc);
  if (cc.length) args.cc = cc;
  if (bcc.length) args.bcc = bcc;
  if (isDraft && input.threadId) args.thread_id = input.threadId;
  return args;
}

async function send(
  input: GmailInput,
  account: GoogleAccountView,
  execute: ComposioGmailExecutor,
  draft: boolean
): Promise<string> {
  if (!input.to && !input.cc && !input.bcc) {
    return "send/draft needs a recipient in to, cc or bcc.";
  }
  if (!String(input.html ?? input.body ?? "").trim()) {
    return "send/draft needs a body.";
  }
  if (Array.isArray(input.attachments) && input.attachments.length > 0) {
    return "Attachments are not wired through Composio yet. Send without attachments or include a Drive link in the body.";
  }
  const args = composeArgs(input, draft);
  if (!draft) delete args.thread_id;
  const data = await execute(
    account.id,
    draft ? "GMAIL_CREATE_EMAIL_DRAFT" : "GMAIL_SEND_EMAIL",
    args
  );
  const id = str(data.id) || str(data.messageId) || str(data.draftId);
  return draft
    ? `Draft created in ${account.email} for ${input.to || input.cc || input.bcc}: ${
        input.subject || "(no subject)"
      }${id ? ` (id ${id})` : ""}.`
    : `Sent from ${account.email} to ${input.to || input.cc || input.bcc}: ${
        input.subject || "(no subject)"
      }${id ? ` (id ${id})` : ""}.`;
}

async function reply(
  input: GmailInput,
  account: GoogleAccountView,
  execute: ComposioGmailExecutor
): Promise<string> {
  if (!input.threadId) return "reply needs a threadId.";
  const body = String(input.html ?? input.body ?? "").trim();
  if (!body) return "reply needs a body.";
  if (Array.isArray(input.attachments) && input.attachments.length > 0) {
    return "Attachments are not wired through Composio yet. Reply without attachments or include a Drive link in the body.";
  }
  let to = String(input.to ?? "").trim();
  let cc = addresses(input.cc);
  if (!to || input.replyAll) {
    const data = await fetchThread(account, input.threadId, execute);
    const messages = arr(data.messages).map(rec);
    const last = messages[messages.length - 1] ?? {};
    const sender = emailOf(last.sender);
    if (!to) to = sender;
    if (input.replyAll) {
      const participants = new Set<string>();
      for (const message of messages) {
        for (const value of [message.to, message.cc]) {
          for (const address of addresses(value)) {
            const email = emailOf(address);
            if (email && email.toLowerCase() !== account.email.toLowerCase()) {
              participants.add(email);
            }
          }
        }
      }
      if (to) participants.delete(to);
      cc = [...new Set([...cc, ...participants])];
    }
  }
  if (!to) return "reply needs a recipient. Pass to or reply from a thread with a sender.";
  const args: Record<string, unknown> = {
    user_id: "me",
    thread_id: input.threadId,
    message_body: body,
    recipient_email: to,
    is_html: Boolean(input.html),
    include_signature: true,
  };
  if (cc.length) args.cc = cc;
  const bcc = addresses(input.bcc);
  if (bcc.length) args.bcc = bcc;
  const data = await execute(account.id, "GMAIL_REPLY_TO_THREAD", args);
  const id = str(data.id) || str(data.messageId);
  return `Replied in ${account.email} to ${to}: ${input.subject || "(thread reply)"}${
    id ? ` (id ${id})` : ""
  }.`;
}

async function manage(
  input: GmailInput,
  account: GoogleAccountView,
  execute: ComposioGmailExecutor
): Promise<string> {
  const threadIds = Array.isArray(input.threadIds)
    ? input.threadIds.filter((id): id is string => typeof id === "string" && id !== "")
    : input.threadId
      ? [input.threadId]
      : [];
  if (threadIds.length === 0) return "manage needs threadIds.";
  if (threadIds.length > 25) return "At most 25 threads can be changed in one call.";
  const operation = String(input.operation ?? "");
  const labelIds = Array.isArray(input.labelIds)
    ? input.labelIds.filter((id): id is string => typeof id === "string" && id !== "")
    : [];
  if ((operation === "apply_label" || operation === "remove_label") && labelIds.length === 0) {
    return `${operation} needs labelIds. Use gmail labels to list them.`;
  }
  const add = new Set<string>();
  const remove = new Set<string>();
  switch (operation) {
    case "archive":
      remove.add("INBOX");
      break;
    case "unarchive":
      add.add("INBOX");
      break;
    case "mark_read":
      remove.add("UNREAD");
      break;
    case "mark_unread":
      add.add("UNREAD");
      break;
    case "star":
      add.add("STARRED");
      break;
    case "unstar":
      remove.add("STARRED");
      break;
    case "spam":
      add.add("SPAM");
      remove.add("INBOX");
      break;
    case "not_spam":
      remove.add("SPAM");
      add.add("INBOX");
      break;
    case "trash":
      add.add("TRASH");
      remove.add("INBOX");
      remove.add("UNREAD");
      break;
    case "untrash":
      remove.add("TRASH");
      add.add("INBOX");
      break;
    case "apply_label":
      for (const id of labelIds) add.add(id);
      break;
    case "remove_label":
      for (const id of labelIds) remove.add(id);
      break;
    case "delete":
      break;
    default:
      return `Unknown manage operation: ${operation || "(none)"}.`;
  }
  const results: string[] = [];
  for (const threadId of threadIds) {
    try {
      const messageIds = await threadMessageIds(account, threadId, execute);
      if (messageIds.length === 0) {
        results.push(`${threadId}: no messages found`);
        continue;
      }
      if (operation === "delete") {
        await execute(account.id, "GMAIL_BATCH_DELETE_MESSAGES", {
          userId: "me",
          messageIds,
        });
        results.push(`${threadId}: permanently deleted ${messageIds.length} message(s)`);
      } else {
        const args: Record<string, unknown> = { userId: "me", messageIds };
        if (add.size) args.addLabelIds = [...add];
        if (remove.size) args.removeLabelIds = [...remove];
        await execute(account.id, "GMAIL_BATCH_MODIFY_MESSAGES", args);
        results.push(`${threadId}: ${operation} on ${messageIds.length} message(s)`);
      }
    } catch (err) {
      results.push(`${threadId}: failed (${String(err).slice(0, 160)})`);
    }
  }
  return `Account: ${account.email}\n${results.join("\n")}`;
}

async function attachment(
  input: GmailInput,
  account: GoogleAccountView,
  execute: ComposioGmailExecutor
): Promise<string> {
  if (!input.messageId || !input.attachmentId || !input.path) {
    return "attachment needs messageId, attachmentId and path.";
  }
  const fileName = input.path.split("/").pop() || "attachment";
  await execute(account.id, "GMAIL_GET_ATTACHMENT", {
    user_id: "me",
    message_id: input.messageId,
    attachment_id: input.attachmentId,
    file_name: fileName,
  });
  return "Composio returned the attachment as a file handle, but saving it into this workspace is not wired yet. The message read view lists the attachment id; use the Gmail web link for now.";
}

/** Run one Gmail tool call against the already-resolved account list. */
export async function runComposioGmail(
  input: GmailInput,
  target: GoogleAccountView[],
  execute: ComposioGmailExecutor
): Promise<string> {
  if (input.action === "accounts") {
    return target
      .map(
        (account) =>
          `${account.email}${account.is_default ? " (default)" : ""} | ${account.status} | ${account.id}`
      )
      .join("\n");
  }
  if (input.action === "search") return search(input, target, execute);
  const account = target[0];
  if (!account) return "No active Gmail account.";
  switch (input.action) {
    case "read":
      return read(input, account, execute);
    case "labels":
      return labels(account, execute);
    case "send":
      return send(input, account, execute, false);
    case "draft":
      return send(input, account, execute, true);
    case "reply":
      return reply(input, account, execute);
    case "manage":
      return manage(input, account, execute);
    case "attachment":
      return attachment(input, account, execute);
    default:
      return `Unsupported Gmail action: ${String(input.action)}`;
  }
}
