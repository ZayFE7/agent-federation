// Shared Gmail/Google connector types. Dependency-free so Node tests can import
// them through type stripping and the registry, routes, and agent can share one
// vocabulary.

export type GoogleAccountStatus = "active" | "reauth_required" | "revoked";

export interface GoogleAccountRow {
  id: string;
  google_sub: string;
  email: string;
  name: string | null;
  picture: string | null;
  refresh_enc: string;
  scopes: string;
  is_default: number;
  status: GoogleAccountStatus;
  last_error: string | null;
  last_refresh_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface GoogleAccountView {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  is_default: boolean;
  status: GoogleAccountStatus;
  scopes: string[];
  last_error: string | null;
  last_refresh_at: number | null;
  created_at: number;
}

export interface GoogleOAuthStateRow {
  state: string;
  redirect_uri: string;
  login_hint: string | null;
  created_at: number;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scopes: string[];
}

export interface GoogleUserInfo {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

export interface GoogleStatusView {
  configured: boolean;
  redirectUri: string | null;
  accounts: number;
  defaultEmail: string | null;
  /** Which OAuth layer owns the accounts. Absent means the native Google app. */
  provider?: "google" | "composio";
}

export type GmailManageOperation =
  | "archive"
  | "unarchive"
  | "mark_read"
  | "mark_unread"
  | "star"
  | "unstar"
  | "spam"
  | "not_spam"
  | "apply_label"
  | "remove_label"
  | "trash"
  | "untrash"
  | "delete";

export type GmailAction =
  | "accounts"
  | "search"
  | "read"
  | "labels"
  | "draft"
  | "send"
  | "reply"
  | "manage"
  | "attachment";

export interface GmailInput {
  action: GmailAction;
  account?: string;
  query?: string;
  limit?: number;
  threadId?: string;
  threadIds?: string[];
  operation?: GmailManageOperation;
  labelIds?: string[];
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  html?: string;
  replyAll?: boolean;
  attachments?: string[];
  messageId?: string;
  attachmentId?: string;
  path?: string;
}

export interface GmailAccountRef {
  id: string;
  email: string;
  name: string | null;
}

export interface GmailThreadSummary {
  account: string;
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  labels: string[];
  unread: boolean;
  messages: number;
}

export interface GmailAttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface GmailMessageView {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  bodyText: string;
  bodyHtml?: string;
  labels: string[];
  attachments: GmailAttachmentMeta[];
}

export interface GmailThreadView {
  account: string;
  id: string;
  subject: string;
  labels: string[];
  messages: GmailMessageView[];
}

export interface GmailLabelView {
  id: string;
  name: string;
  type: string;
}

export interface GmailAttachmentFile {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface GmailAccess {
  account: GoogleAccountView;
  accessToken: string;
}

export type GmailAccessResult =
  | { ok: true; access: GmailAccess }
  | { ok: false; error: string; reauth: boolean };

const MAX = {
  searchLimit: 20,
  manageThreads: 20,
  attachmentFiles: 10,
  attachmentBytes: 10 * 1024 * 1024,
  bodyChars: 60_000,
  htmlChars: 40_000,
} as const;

export const GMAIL_LIMITS = MAX;
export const GMAIL_SCOPE =
  "openid email profile https://mail.google.com/";
export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export const GMAIL_SYSTEM_LABELS: Record<string, string> = {
  INBOX: "Inbox",
  UNREAD: "Unread",
  STARRED: "Starred",
  IMPORTANT: "Important",
  SENT: "Sent",
  DRAFT: "Draft",
  SPAM: "Spam",
  TRASH: "Trash",
  CATEGORY_PERSONAL: "Primary",
  CATEGORY_SOCIAL: "Social",
  CATEGORY_PROMOTIONS: "Promotions",
  CATEGORY_UPDATES: "Updates",
  CATEGORY_FORUMS: "Forums",
};

export function gmailAccountLabel(row: { email: string; name?: string | null }): string {
  return row.name && row.name.trim() && row.name !== row.email
    ? `${row.name} <${row.email}>`
    : row.email;
}

export function isGmailWrite(action: GmailAction): boolean {
  return action === "send" || action === "reply" || action === "manage";
}

export function isGmailDestructive(input: GmailInput): boolean {
  if (input.action !== "manage") return false;
  if (input.operation === "trash" || input.operation === "delete") return true;
  return Array.isArray(input.threadIds) && input.threadIds.length > 10;
}
