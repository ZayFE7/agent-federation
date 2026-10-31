// Chat attachments: name and path rules, the model-facing preamble, and the
// parser the message route uses. Pure, so tests and the DO share one definition.

import { safeWorkspacePath } from "./workspace-keys.ts";

export interface MessageAttachment {
  /** The name the user sees, not the stored filename. */
  name: string;
  /** Workspace-relative path, always under uploads/. */
  path: string;
  bytes: number;
}

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

const MAX_NAME = 80;

/** A display name with no separators or control characters, or null. */
export function safeAttachmentName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const base = raw
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (!base) return null;
  if (base === "." || base === "..") return null;
  if (base.length > MAX_NAME) return null;
  return base;
}

export function attachmentExtension(name: string): string {
  const match = /\.([A-Za-z0-9]{1,12})$/.exec(name);
  return match ? `.${match[1].toLowerCase()}` : "";
}

/** A unique, path-safe stored name. The display name keeps the readable part. */
export function storedAttachmentPath(name: string, stamp = Date.now()): string {
  const ext = attachmentExtension(name);
  const stem = name
    .slice(0, name.length - ext.length)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 48) || "file";
  const nonce = Math.random().toString(36).slice(2, 8);
  return `uploads/${stem}-${stamp.toString(36)}${nonce}${ext}`;
}

/** Validated attachment list, or null when any entry is malformed. */
export function parseAttachments(value: unknown): MessageAttachment[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return null;
  const out: MessageAttachment[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const name = safeAttachmentName((item as { name?: unknown }).name);
    const rawPath = (item as { path?: unknown }).path;
    const bytes = (item as { bytes?: unknown }).bytes;
    if (!name || typeof rawPath !== "string") return null;
    const path = safeWorkspacePath(rawPath);
    if (!path || !path.startsWith("uploads/")) return null;
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
    if (bytes > MAX_ATTACHMENT_BYTES) return null;
    if (seen.has(path)) return null;
    seen.add(path);
    out.push({ name, path, bytes });
  }
  return out;
}

/**
 * The model-facing text. The transcript keeps the user's own words; this block
 * only travels to the harness, so the model knows the files exist and where.
 */
export function attachmentPreamble(
  content: string,
  attachments: readonly MessageAttachment[],
  home: string
): string {
  if (attachments.length === 0) return content;
  const lines = attachments.map(
    (file) =>
      `- ${home}/${file.path} (${file.name}, ${file.bytes} bytes)`
  );
  return (
    `${content}\n\n[The user attached ${attachments.length} file` +
    `${attachments.length === 1 ? "" : "s"} to this message. ` +
    `They are already in the sandbox; read them with the exec tool before answering.\n` +
    `${lines.join("\n")}]`
  );
}
