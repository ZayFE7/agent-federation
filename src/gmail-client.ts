// Gmail API v1 client and MIME helpers for the native multi-account connector.
//
// Everything here is pure over an injected `fetch`: the RegistryAgent owns
// OAuth refresh and account selection, and the gmail tool owns approvals. This
// module only turns typed requests into Gmail REST calls and turns the JSON
// back into small, capped, display shapes. No token is ever put in a thrown
// error, a URL, or a log line.
//
// It stays dependency-free apart from the shared types so plain Node can import
// it (`.ts` extension, Node strips the types) and tests need no build step.

import {
  GMAIL_API,
  GMAIL_LIMITS,
  type GmailAttachmentFile,
  type GmailAttachmentMeta,
  type GmailLabelView,
  type GmailManageOperation,
  type GmailMessageView,
  type GmailThreadSummary,
  type GmailThreadView,
} from "./google-types.ts";

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_ERROR_TEXT = 400;

/** A file to attach to a composed message. Content is raw bytes or base64. */
export interface ComposeAttachment {
  filename: string;
  mimeType?: string;
  /** Alias some callers use for `mimeType`. */
  contentType?: string;
  /** Preferred: raw bytes from the workspace. */
  bytes?: Uint8Array | ArrayBuffer;
  /** Raw bytes, or a base64/base64url string for callers that serialize. */
  content?: Uint8Array | ArrayBuffer | string;
  /** Base64/base64url content, when `bytes` and `content` are absent. */
  data?: string;
}

/** The message body/headers the MIME builder and send methods accept. */
export interface ComposeInput {
  to?: string;
  cc?: string;
  bcc?: string;
  from?: string;
  subject?: string;
  /** text/plain body. `text` is accepted as an alias. */
  body?: string;
  text?: string;
  /** text/html body. */
  html?: string;
  attachments?: ComposeAttachment[];
  inReplyTo?: string;
  references?: string | string[];
  /** Set by replyMessage, or to create a draft on an existing thread. */
  threadId?: string;
}

/** A Gmail message payload part, with only the fields this connector reads. */
export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailMessagePart[];
}

/** The body pieces extracted from one message payload. */
export interface ParsedThreadPayload {
  text: string;
  html: string;
  attachments: GmailAttachmentMeta[];
}

/** The label change a manage operation maps to. */
export interface GmailLabelChange {
  addLabelIds: string[];
  removeLabelIds: string[];
}

interface GmailMessageResponse {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailMessagePart;
}

interface GmailThreadResponse {
  id?: string;
  snippet?: string;
  labelIds?: string[];
  messages?: GmailMessageResponse[];
}

interface GmailThreadListResponse {
  threads?: Array<{ id?: string }>;
}

interface GmailLabelListResponse {
  labels?: Array<{ id?: string; name?: string; type?: string }>;
}

interface GmailAttachmentResponse {
  size?: number;
  data?: string;
}

interface GoogleErrorBody {
  error?:
    | string
    | {
        message?: string;
        status?: string;
        errors?: Array<{ reason?: string; message?: string }>;
      };
}

/**
 * A Gmail API response that failed. `status` is the HTTP status (0 for a
 * transport failure before a response), `retryAfter` is seconds parsed from
 * Retry-After, and the message is already redacted and length-capped.
 */
export class GmailApiError extends Error {
  readonly status: number;
  readonly retryAfter: number | null;
  readonly reason: string | null;

  constructor(
    status: number,
    message: string,
    retryAfter: number | null = null,
    reason: string | null = null
  ) {
    super(message);
    this.name = "GmailApiError";
    this.status = status;
    this.retryAfter = retryAfter;
    this.reason = reason;
  }
}

/** Gmail answered 401: the access token is expired, revoked, or wrong. */
export class GmailAuthError extends GmailApiError {
  constructor(message = "Gmail authorization failed (401). Reconnect the account and try again.") {
    super(401, message);
    this.name = "GmailAuthError";
  }
}

/** Gmail client over an injected fetch. One instance may serve many accounts. */
export class GmailClient {
  private readonly fetchFn: typeof fetch;

  constructor(options: { fetch: typeof fetch }) {
    if (!options || typeof options.fetch !== "function") {
      throw new TypeError("GmailClient requires a fetch implementation.");
    }
    this.fetchFn = options.fetch;
  }

  /**
   * Search threads, then fetch each thread in metadata format. `limit` is
   * clamped to Gmail's 20-result tool budget. The account email is copied onto
   * every row so cross-account results stay labeled by the caller.
   */
  async searchThreads(
    accessToken: string,
    accountEmail: string,
    query: string,
    limit = DEFAULT_SEARCH_LIMIT
  ): Promise<GmailThreadSummary[]> {
    const max = clampSearchLimit(limit);
    const params = new URLSearchParams();
    const trimmed = (query ?? "").trim();
    if (trimmed) params.set("q", trimmed);
    params.set("maxResults", String(max));

    const list = await this.call<GmailThreadListResponse>(
      accessToken,
      `/threads?${params.toString()}`
    );
    const ids = (list?.threads ?? [])
      .map((thread) => thread?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .slice(0, max);

    const summaries: GmailThreadSummary[] = [];
    for (const id of ids) {
      const thread = await this.call<GmailThreadResponse>(
        accessToken,
        threadMetadataPath(id)
      );
      const messages = thread?.messages ?? [];
      const first = messages[0];
      const headers = first?.payload?.headers ?? [];
      const labels = cleanLabelIds(thread?.labelIds ?? first?.labelIds);
      summaries.push({
        account: accountEmail,
        id: thread?.id ?? id,
        subject: headerValue(headers, "subject"),
        from: headerValue(headers, "from"),
        date: headerValue(headers, "date"),
        snippet: thread?.snippet ?? first?.snippet ?? "",
        labels,
        unread: labels.includes("UNREAD"),
        messages: messages.length,
      });
    }
    return summaries;
  }

  /** Read every message in a thread, with capped text, html, and attachment metadata. */
  async readThread(
    accessToken: string,
    accountEmail: string,
    threadId: string
  ): Promise<GmailThreadView> {
    if (!threadId) throw new Error("readThread requires a thread id.");
    const thread = await this.call<GmailThreadResponse>(
      accessToken,
      `/threads/${encodeURIComponent(threadId)}?format=full`
    );
    const messages = (thread?.messages ?? []).map((message) => {
      const payload = message.payload;
      const parsed = parseThreadPayload(payload);
      const headers = payload?.headers ?? [];
      const bodyText = capText(
        parsed.text || htmlToText(parsed.html),
        GMAIL_LIMITS.bodyChars
      );
      const view: GmailMessageView = {
        id: message.id ?? "",
        threadId: message.threadId ?? thread?.id ?? threadId,
        from: headerValue(headers, "from"),
        to: headerValue(headers, "to"),
        cc: headerValue(headers, "cc"),
        subject: headerValue(headers, "subject"),
        date: headerValue(headers, "date"),
        bodyText,
        labels: cleanLabelIds(message.labelIds),
        attachments: parsed.attachments,
      };
      if (parsed.html) {
        view.bodyHtml = capText(parsed.html, GMAIL_LIMITS.htmlChars);
      }
      return view;
    });

    return {
      account: accountEmail,
      id: thread?.id ?? threadId,
      subject: messages[0]?.subject ?? "",
      labels: cleanLabelIds(thread?.labelIds ?? messages[0]?.labels),
      messages,
    };
  }

  /** List system and user labels for the account. */
  async listLabels(accessToken: string): Promise<GmailLabelView[]> {
    const data = await this.call<GmailLabelListResponse>(accessToken, "/labels");
    return (data?.labels ?? [])
      .filter((label): label is { id: string; name?: string; type?: string } =>
        typeof label?.id === "string" && label.id.length > 0
      )
      .map((label) => ({
        id: label.id,
        name: label.name ?? label.id,
        type: label.type ?? "user",
      }));
  }

  /** Add/remove labels on a thread. Archive, read, star, and spam all use this. */
  async modifyThread(
    accessToken: string,
    threadId: string,
    addLabelIds: string[],
    removeLabelIds: string[]
  ): Promise<void> {
    const body = JSON.stringify({
      addLabelIds: cleanLabelIds(addLabelIds),
      removeLabelIds: cleanLabelIds(removeLabelIds),
    });
    await this.call<unknown>(
      accessToken,
      `/threads/${encodeURIComponent(threadId)}/modify`,
      { method: "POST", body }
    );
  }

  /** Move a thread to Trash. Reversible; permanent deletion is deleteThread. */
  async trashThread(accessToken: string, threadId: string): Promise<void> {
    await this.call<unknown>(
      accessToken,
      `/threads/${encodeURIComponent(threadId)}/trash`,
      { method: "POST" }
    );
  }

  /** Restore a thread from Trash. */
  async untrashThread(accessToken: string, threadId: string): Promise<void> {
    await this.call<unknown>(
      accessToken,
      `/threads/${encodeURIComponent(threadId)}/untrash`,
      { method: "POST" }
    );
  }

  /** Permanently delete a thread. The caller must have explicit approval. */
  async deleteThread(accessToken: string, threadId: string): Promise<void> {
    await this.call<unknown>(
      accessToken,
      `/threads/${encodeURIComponent(threadId)}`,
      { method: "DELETE" }
    );
  }

  /** Create a draft with a MIME raw message. No approval is required for drafts. */
  async createDraft(
    accessToken: string,
    compose: ComposeInput
  ): Promise<{ id: string }> {
    const raw = buildMimeMessage(compose);
    const message: { raw: string; threadId?: string } = { raw };
    if (compose.threadId) message.threadId = compose.threadId;
    const data = await this.call<{ id?: string }>(accessToken, "/drafts", {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    if (!data?.id) throw new Error("Gmail did not return a draft id.");
    return { id: data.id };
  }

  /** Send a new message. The caller must have approval for this action. */
  async sendMessage(
    accessToken: string,
    compose: ComposeInput
  ): Promise<{ id: string; threadId: string }> {
    const raw = buildMimeMessage(compose);
    const data = await this.call<{ id?: string; threadId?: string }>(
      accessToken,
      "/messages/send",
      { method: "POST", body: JSON.stringify({ raw }) }
    );
    return {
      id: data?.id ?? "",
      threadId: data?.threadId ?? "",
    };
  }

  /**
   * Send a reply in an existing thread. `threadId` is required; In-Reply-To and
   * References come from the compose input and are written by the MIME builder.
   */
  async replyMessage(
    accessToken: string,
    compose: ComposeInput & { threadId: string }
  ): Promise<{ id: string; threadId: string }> {
    if (!compose.threadId || !compose.threadId.trim()) {
      throw new Error("replyMessage requires a threadId.");
    }
    const raw = buildMimeMessage(compose);
    const data = await this.call<{ id?: string; threadId?: string }>(
      accessToken,
      "/messages/send",
      {
        method: "POST",
        body: JSON.stringify({ raw, threadId: compose.threadId }),
      }
    );
    return {
      id: data?.id ?? "",
      threadId: data?.threadId ?? compose.threadId,
    };
  }

  /**
   * Download one attachment by id. Filename and MIME type are usually present
   * in the thread view; when they are not, one message metadata read locates
   * the matching part before the download.
   */
  async getAttachment(
    accessToken: string,
    messageId: string,
    attachmentId: string,
    filename?: string,
    mimeType?: string
  ): Promise<GmailAttachmentFile> {
    if (!messageId || !attachmentId) {
      throw new Error("getAttachment requires a message id and an attachment id.");
    }
    let resolvedFilename = (filename ?? "").trim();
    let resolvedMimeType = (mimeType ?? "").trim();

    if (!resolvedFilename || !resolvedMimeType) {
      const message = await this.call<GmailMessageResponse>(
        accessToken,
        `/messages/${encodeURIComponent(messageId)}?format=full`
      );
      const part = findAttachmentPart(message?.payload, attachmentId);
      if (!resolvedFilename) resolvedFilename = part?.filename?.trim() ?? "";
      if (!resolvedMimeType) resolvedMimeType = part?.mimeType?.trim() ?? "";
    }

    const data = await this.call<GmailAttachmentResponse>(
      accessToken,
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
    );
    if (!data || typeof data.data !== "string") {
      throw new Error("Gmail did not return attachment data.");
    }
    return {
      filename: resolvedFilename || "attachment",
      mimeType: resolvedMimeType || "application/octet-stream",
      bytes: decodeBase64UrlBytes(data.data),
    };
  }

  /**
   * One JSON request. A 401 becomes GmailAuthError; 403/429 and other failures
   * become GmailApiError. Error text is redacted and capped before it leaves
   * this method.
   */
  private async call<T>(
    accessToken: string,
    path: string,
    init: { method?: string; body?: string } = {}
  ): Promise<T | undefined> {
    const url = `${GMAIL_API}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    };
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: init.method ?? "GET",
        headers,
        body: init.body,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new GmailApiError(
        0,
        `Gmail request failed before a response: ${redact(detail, accessToken)}`
      );
    }

    let text = "";
    let parsed: unknown;
    let alreadyParsed = false;
    try {
      text = await response.text();
    } catch {
      // A minimal test double may expose only json(); keep the error path
      // readable by serializing it back to text.
      try {
        parsed = await response.json();
        alreadyParsed = true;
        text = JSON.stringify(parsed);
      } catch {
        text = "";
      }
    }

    const status =
      typeof response.status === "number" ? response.status : 0;
    const ok =
      typeof response.ok === "boolean"
        ? response.ok
        : status >= 200 && status < 300;

    if (!ok) {
      if (status === 401) throw new GmailAuthError();
      const retryAfter = parseRetryAfter(responseHeader(response, "Retry-After"));
      const info = errorInfo(text, accessToken);
      throw new GmailApiError(
        status,
        formatApiError(status, info.message, info.reason, retryAfter),
        retryAfter,
        info.reason || null
      );
    }

    if (alreadyParsed) return parsed as T;
    if (!text) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GmailApiError(
        status,
        `Gmail returned an unreadable response (status ${status}).`
      );
    }
  }
}

/**
 * Build a base64url MIME raw message for messages.send / drafts.create.
 * Text and HTML become multipart/alternative; attachments wrap that in
 * multipart/mixed. Header values are stripped of CR/LF so a subject cannot
 * inject headers. Attachment limits are enforced before any encoding work.
 */
export function buildMimeMessage(compose: ComposeInput, boundary?: string): string {
  const attachments = (compose.attachments ?? []).map((attachment) =>
    normalizeAttachment(attachment)
  );
  if (attachments.length > GMAIL_LIMITS.attachmentFiles) {
    throw new Error(
      `Too many attachments: ${attachments.length}. A message may include at most ${GMAIL_LIMITS.attachmentFiles} attachments.`
    );
  }
  const totalBytes = attachments.reduce((sum, item) => sum + item.bytes.byteLength, 0);
  if (totalBytes > GMAIL_LIMITS.attachmentBytes) {
    throw new Error(
      `Attachments are too large: ${formatMegabytes(totalBytes)} total. The limit is ${formatMegabytes(
        GMAIL_LIMITS.attachmentBytes
      )}.`
    );
  }

  const text = compose.body ?? compose.text ?? "";
  const html = compose.html ?? "";
  const hasText = text.length > 0;
  const hasHtml = html.length > 0;

  const outerBoundary = safeBoundary(boundary) || generateBoundary();
  // The caller's boundary names the top-level multipart. Only a nested
  // alternative inside multipart/mixed needs a second, derived boundary.
  const alternativeBoundary =
    attachments.length > 0 ? `${outerBoundary}_alt` : outerBoundary;

  let bodyContent: string;
  let bodyType: string;
  let mixedBodyPart: string;
  if (hasText && hasHtml) {
    const alternative = multipartBody(alternativeBoundary, [
      textPart("text/plain", text),
      textPart("text/html", html),
    ]);
    bodyContent = alternative;
    bodyType = `multipart/alternative; boundary="${alternativeBoundary}"`;
    mixedBodyPart = `Content-Type: ${bodyType}\r\n\r\n${alternative}`;
  } else if (hasHtml) {
    bodyContent = encodedBody(html);
    bodyType = 'text/html; charset="UTF-8"';
    mixedBodyPart = textPart("text/html", html);
  } else {
    bodyContent = encodedBody(text);
    bodyType = 'text/plain; charset="UTF-8"';
    mixedBodyPart = textPart("text/plain", text);
  }

  let contentType: string;
  let body: string;
  if (attachments.length > 0) {
    body = multipartBody(outerBoundary, [
      mixedBodyPart,
      ...attachments.map(attachmentPart),
    ]);
    contentType = `multipart/mixed; boundary="${outerBoundary}"`;
  } else {
    body = bodyContent;
    contentType = bodyType;
  }

  const headerLines: string[] = [];
  addAddressHeader(headerLines, "To", compose.to);
  addAddressHeader(headerLines, "Cc", compose.cc);
  addAddressHeader(headerLines, "Bcc", compose.bcc);
  addAddressHeader(headerLines, "From", compose.from);
  if (compose.subject !== undefined) {
    headerLines.push(`Subject: ${encodeHeaderText(compose.subject)}`);
  }
  if (compose.inReplyTo) {
    headerLines.push(`In-Reply-To: ${cleanHeaderValue(compose.inReplyTo)}`);
  }
  const references = Array.isArray(compose.references)
    ? compose.references
    : compose.references
      ? [compose.references]
      : [];
  const referenceLine = references
    .map(cleanHeaderValue)
    .filter(Boolean)
    .join(" ");
  if (referenceLine) {
    headerLines.push(`References: ${referenceLine}`);
  }
  headerLines.push("MIME-Version: 1.0");
  headerLines.push(`Content-Type: ${contentType}`);

  const mime = `${headerLines.join("\r\n")}\r\n\r\n${body}`;
  return encodeBase64Url(mime);
}

/**
 * Walk a Gmail payload recursively. Parts with an attachmentId are metadata
 * only (download separately); body text is base64url decoded. The first and
 * only text/plain becomes `text`, and text/html is kept separately.
 */
export function parseThreadPayload(
  payload?: GmailMessagePart | null
): ParsedThreadPayload {
  const texts: string[] = [];
  const htmls: string[] = [];
  const attachments: GmailAttachmentMeta[] = [];

  const walk = (part?: GmailMessagePart | null): void => {
    if (!part) return;
    const mimeType = (part.mimeType ?? "").toLowerCase();
    const attachmentId = part.body?.attachmentId;

    if (attachmentId) {
      attachments.push({
        id: attachmentId,
        filename: part.filename || "attachment",
        mimeType: part.mimeType || "application/octet-stream",
        size: typeof part.body?.size === "number" ? part.body.size : 0,
      });
      return;
    }

    const data = part.body?.data;
    if (typeof data === "string" && data.length > 0 && !part.filename) {
      const decoded = tryDecodeBase64Url(data);
      if (mimeType === "text/plain") texts.push(decoded);
      else if (mimeType === "text/html") htmls.push(decoded);
    }

    for (const child of part.parts ?? []) walk(child);
  };

  walk(payload);
  return {
    text: texts.join("\n"),
    html: htmls.join("\n"),
    attachments,
  };
}

/** The Gmail label change for a manage operation. */
export function gmailLabelIdsForOperation(
  operation: GmailManageOperation,
  labelIds: string[] = []
): GmailLabelChange {
  const labels = cleanLabelIds(labelIds);
  switch (operation) {
    case "archive":
      return { addLabelIds: [], removeLabelIds: ["INBOX"] };
    case "unarchive":
      return { addLabelIds: ["INBOX"], removeLabelIds: [] };
    case "mark_read":
      return { addLabelIds: [], removeLabelIds: ["UNREAD"] };
    case "mark_unread":
      return { addLabelIds: ["UNREAD"], removeLabelIds: [] };
    case "star":
      return { addLabelIds: ["STARRED"], removeLabelIds: [] };
    case "unstar":
      return { addLabelIds: [], removeLabelIds: ["STARRED"] };
    case "spam":
      return { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] };
    case "not_spam":
      return { addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] };
    case "apply_label":
      return { addLabelIds: labels, removeLabelIds: [] };
    case "remove_label":
      return { addLabelIds: [], removeLabelIds: labels };
    case "trash":
    case "untrash":
    case "delete":
      return { addLabelIds: [], removeLabelIds: [] };
    default:
      throw new Error(`Unsupported Gmail operation: ${String(operation)}`);
  }
}

/** Decode base64url (also tolerates standard base64 and whitespace) to UTF-8 text. */
export function decodeBase64Url(value: string): string {
  return new TextDecoder().decode(decodeBase64UrlBytes(value));
}

/** Encode UTF-8 text as unpadded base64url. */
export function encodeBase64Url(value: string): string {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

/**
 * Truncate text to a character budget and append an explicit marker naming the
 * budget and the original length. Short text is returned unchanged.
 */
export function capText(text: string, limit: number): string {
  const source = typeof text === "string" ? text : "";
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (source.length <= max) return source;
  return `${source.slice(0, max)}\n\n[truncated: showing first ${max} of ${source.length} characters]`;
}

function clampSearchLimit(limit: number): number {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_SEARCH_LIMIT;
  return Math.min(GMAIL_LIMITS.searchLimit, Math.max(1, Math.floor(value)));
}

function threadMetadataPath(threadId: string): string {
  const params = new URLSearchParams({ format: "metadata" });
  for (const header of ["From", "To", "Subject", "Date"]) {
    params.append("metadataHeaders", header);
  }
  return `/threads/${encodeURIComponent(threadId)}?${params.toString()}`;
}

function cleanLabelIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function findAttachmentPart(
  part: GmailMessagePart | undefined,
  attachmentId: string
): GmailMessagePart | undefined {
  if (!part) return undefined;
  if (part.body?.attachmentId === attachmentId) return part;
  for (const child of part.parts ?? []) {
    const found = findAttachmentPart(child, attachmentId);
    if (found) return found;
  }
  return undefined;
}

function headerValue(
  headers: Array<{ name?: string; value?: string }>,
  name: string
): string {
  const wanted = name.toLowerCase();
  for (const header of headers) {
    if ((header.name ?? "").toLowerCase() === wanted) {
      return decodeHeaderValue(header.value ?? "");
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// MIME construction
// ---------------------------------------------------------------------------

interface NormalizedAttachment {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

function normalizeAttachment(attachment: ComposeAttachment): NormalizedAttachment {
  const filename = safeFilename(attachment?.filename);
  const mimeType = safeMimeType(attachment?.mimeType ?? attachment?.contentType);
  let bytes: Uint8Array;

  try {
    if (attachment?.bytes instanceof Uint8Array) {
      bytes = attachment.bytes;
    } else if (attachment?.bytes instanceof ArrayBuffer) {
      bytes = new Uint8Array(attachment.bytes);
    } else if (attachment?.content instanceof Uint8Array) {
      bytes = attachment.content;
    } else if (attachment?.content instanceof ArrayBuffer) {
      bytes = new Uint8Array(attachment.content);
    } else if (typeof attachment?.content === "string") {
      bytes = decodeBase64UrlBytes(attachment.content);
    } else if (typeof attachment?.data === "string") {
      bytes = decodeBase64UrlBytes(attachment.data);
    } else {
      throw new Error("no content");
    }
  } catch {
    throw new Error(`Attachment "${filename}" has no readable content.`);
  }

  return { filename, mimeType, bytes };
}

function textPart(mimeType: string, content: string): string {
  return [
    `Content-Type: ${mimeType}; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    encodedBody(content),
  ].join("\r\n");
}

function encodedBody(content: string): string {
  return wrapBase64(bytesToBase64(new TextEncoder().encode(content)));
}

function attachmentPart(attachment: NormalizedAttachment): string {
  const encoded = bytesToBase64(attachment.bytes);
  const fallbackName = attachment.filename.replace(/[^\x20-\x7E]/g, "_");
  const asciiName = fallbackName.replace(/["\\]/g, "_") || "attachment";
  const encodedName = rfc2231Value(attachment.filename);
  const nameParameter =
    encodedName === asciiName
      ? `name="${asciiName}"`
      : `name="${asciiName}"; name*=UTF-8''${encodedName}`;
  const filenameParameter =
    encodedName === asciiName
      ? `filename="${asciiName}"`
      : `filename="${asciiName}"; filename*=UTF-8''${encodedName}`;

  return [
    `Content-Type: ${attachment.mimeType}; ${nameParameter}`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; ${filenameParameter}`,
    "",
    wrapBase64(encoded),
  ].join("\r\n");
}

function multipartBody(boundary: string, parts: string[]): string {
  let out = "";
  for (const part of parts) {
    out += `--${boundary}\r\n${part}\r\n`;
  }
  out += `--${boundary}--`;
  return out;
}

function addAddressHeader(lines: string[], name: string, value?: string): void {
  const clean = cleanHeaderValue(value);
  if (clean) lines.push(`${name}: ${clean}`);
}

function safeBoundary(value?: string): string {
  if (!value) return "";
  return value.replace(/[^A-Za-z0-9'()+_,./:=?-]/g, "").slice(0, 70);
}

function generateBoundary(): string {
  return `blip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function safeFilename(value: unknown): string {
  const name = String(value ?? "").replace(/[\r\n]+/g, " ").trim();
  return name || "attachment";
}

function safeMimeType(value: unknown): string {
  const base = String(value ?? "application/octet-stream")
    .split(";")[0]
    .trim()
    .toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(base)
    ? base
    : "application/octet-stream";
}

function rfc2231Value(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function cleanHeaderValue(value: unknown): string {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function encodeHeaderText(value: string): string {
  const clean = cleanHeaderValue(value);
  if (!/[^\x20-\x7E]/.test(clean)) return clean;

  const encoder = new TextEncoder();
  const words: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of clean) {
    const size = encoder.encode(char).byteLength;
    if (current && currentBytes + size > 45) {
      words.push(encodedWord(current));
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += size;
  }
  if (current) words.push(encodedWord(current));
  return words.join("\r\n ");
}

function encodedWord(value: string): string {
  return `=?UTF-8?B?${bytesToBase64(new TextEncoder().encode(value))}?=`;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Headers and HTML fallback
// ---------------------------------------------------------------------------

function decodeHeaderValue(raw: string): string {
  const unfolded = raw.replace(/\r?\n\s+/g, " ");
  const joined = unfolded.replace(/\?=\s+=\?/g, "?==?");
  return joined
    .replace(/=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset, encoding, data) => {
      try {
        const bytes =
          String(encoding).toUpperCase() === "B"
            ? decodeBase64UrlBytes(String(data))
            : decodeQuotedPrintableWord(String(data));
        return new TextDecoder(normalizeCharset(String(charset))).decode(bytes);
      } catch {
        return whole;
      }
    })
    .trim();
}

function normalizeCharset(charset: string): string {
  const value = charset.toLowerCase();
  if (value === "utf8") return "utf-8";
  return value;
}

function decodeQuotedPrintableWord(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === "_") {
      bytes.push(0x20);
    } else if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(char.charCodeAt(0) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function htmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Base64url
// ---------------------------------------------------------------------------

function decodeBase64UrlBytes(value: string): Uint8Array {
  const normalized = String(value)
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function tryDecodeBase64Url(value: string): string {
  try {
    return decodeBase64Url(value);
  } catch {
    return "";
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const size = 0x8000;
  for (let i = 0; i < bytes.length; i += size) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + size)));
  }
  return btoa(chunks.join(""));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function wrapBase64(value: string, width = 76): string {
  if (!value) return "";
  const lines: string[] = [];
  for (let i = 0; i < value.length; i += width) {
    lines.push(value.slice(i, i + width));
  }
  return lines.join("\r\n");
}

// ---------------------------------------------------------------------------
// API errors
// ---------------------------------------------------------------------------

function responseHeader(response: Response, name: string): string | null {
  const headers = (
    response as { headers?: { get?: (headerName: string) => string | null } }
  ).headers;
  if (!headers || typeof headers.get !== "function") return null;
  try {
    return headers.get(name);
  } catch {
    return null;
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
}

function errorInfo(
  body: string,
  accessToken: string
): { message: string; reason: string } {
  if (!body) return { message: "", reason: "" };
  let parsed: GoogleErrorBody | undefined;
  try {
    parsed = JSON.parse(body) as GoogleErrorBody;
  } catch {
    return { message: redact(body, accessToken), reason: "" };
  }
  const error = parsed?.error;
  if (typeof error === "string") {
    return { message: redact(error, accessToken), reason: "" };
  }
  const message = typeof error?.message === "string" ? error.message : "";
  const first = Array.isArray(error?.errors) ? error.errors[0] : undefined;
  const detail = typeof first?.message === "string" ? first.message : message;
  const reason =
    typeof first?.reason === "string"
      ? first.reason
      : typeof error?.status === "string"
        ? error.status
        : "";
  return {
    message: redact(detail || message, accessToken),
    reason: redact(reason, accessToken).slice(0, 80),
  };
}

function formatApiError(
  status: number,
  message: string,
  reason: string,
  retryAfter: number | null
): string {
  const fallback =
    status === 429
      ? "Too many requests."
      : status === 403
        ? "Permission denied."
        : "Request failed.";
  let text = `Gmail API error ${status}`;
  if (reason) text += ` (${reason})`;
  text += `: ${message || fallback}`;
  if (retryAfter !== null) {
    text += ` Retry after ${retryAfter} second${retryAfter === 1 ? "" : "s"} (Retry-After).`;
  }
  return text;
}

/**
 * Remove the access token, bearer headers, and common Google token shapes from
 * any error text, collapse whitespace, and cap the result.
 */
function redact(text: string, accessToken: string): string {
  let out = String(text ?? "");
  if (accessToken) out = out.split(accessToken).join("[redacted]");
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  out = out.replace(/\bya29\.[A-Za-z0-9._-]+/g, "[redacted]");
  return out.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_TEXT);
}
