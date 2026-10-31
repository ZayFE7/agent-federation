// Pure ingress security helpers for automations: secret generation, constant-time
// comparisons, GitHub HMAC verification, body caps, URL guards, and header
// redaction. Web APIs only, so the same code runs in Workers and plain Node.

import type { WatchSource } from "./automation-types.ts";
import { AUTOMATION_LIMITS } from "./automation-types.ts";

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** 32 random bytes as unpadded base64url (43 characters). */
export function generateSecret(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The last four characters, for display. Never the whole secret. */
export function secretHint(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 8) return "••••";
  return secret.slice(-4);
}

/** Length-independent byte comparison. Empty input always fails closed. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = i < a.length ? a[i] : 0;
    const right = i < b.length ? b[i] : 0;
    diff |= left ^ right;
  }
  return diff === 0;
}

/** Constant-time secret check. Either side empty is a failure. */
export function verifySecret(provided: string, expected: string): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  if (!provided || !expected) return false;
  return timingSafeEqual(encoder.encode(provided), encoder.encode(expected));
}

const SHA256_SIGNATURE = /^sha256=([0-9a-fA-F]{64})$/;

/** GitHub `X-Hub-Signature-256` check over the exact request bytes. */
export async function verifyGithubSignature(
  rawBody: Uint8Array,
  header: string | null,
  secret: string
): Promise<boolean> {
  if (!(rawBody instanceof Uint8Array)) return false;
  if (!secret) return false;
  if (typeof header !== "string") return false;
  const match = SHA256_SIGNATURE.exec(header.trim());
  if (!match) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signed = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
    const expected = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      expected[i] = Number.parseInt(match[1].slice(i * 2, i * 2 + 2), 16);
    }
    return timingSafeEqual(signed, expected);
  } catch {
    return false;
  }
}

/** 128 KB UTF-8 body cap, checked before parsing. */
export function safeIngressBody(
  body: string
): { ok: true; bytes: number } | { ok: false; error: "too_large"; bytes: number } {
  const bytes = typeof body === "string" ? encoder.encode(body).byteLength : 0;
  if (bytes > AUTOMATION_LIMITS.maxBodyBytes) {
    return { ok: false, error: "too_large", bytes };
  }
  return { ok: true, bytes };
}

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function parseIpv6(input: string): number[] | null {
  let host = input;
  const zone = host.indexOf("%");
  if (zone >= 0) host = host.slice(0, zone);
  host = host.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(host)) return null;

  const lastColon = host.lastIndexOf(":");
  if (lastColon < 0) return null;
  const tail = host.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    const high = ((v4[0] << 8) | v4[1]).toString(16);
    const low = ((v4[2] << 8) | v4[3]).toString(16);
    host = `${host.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = host.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    const rest = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array(missing).fill("0"), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push((value >>> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

function isPrivateIpv6(bytes: number[]): boolean {
  const zeros = (length: number) => bytes.slice(0, length).every((byte) => byte === 0);
  if (zeros(16)) return true; // ::
  if (zeros(15) && bytes[15] === 1) return true; // ::1
  if (zeros(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateIpv4(bytes.slice(12)); // IPv4-mapped
  }
  if (zeros(12)) return isPrivateIpv4(bytes.slice(12)); // IPv4-compatible
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    if (bytes.slice(4, 12).every((byte) => byte === 0)) {
      return isPrivateIpv4(bytes.slice(12)); // NAT64
    }
  }
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (bytes[0] === 0xff) return true; // multicast
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return true; // 2001:db8::/32 documentation
  }
  return false;
}

/**
 * A fetchable public http(s) URL, normalized, or null. Rejects credentials,
 * non-http(s) schemes, localhost/*.local, single-label hosts, and private,
 * loopback, link-local, multicast, and documentation IP literals.
 */
export function safeFetchUrl(raw: string): string | null {
  if (typeof raw !== "string" || !raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;

  const hostname = url.hostname.toLowerCase();
  if (!hostname) return null;

  if (hostname.startsWith("[")) {
    if (!hostname.endsWith("]")) return null;
    const bytes = parseIpv6(hostname.slice(1, -1));
    if (!bytes || isPrivateIpv6(bytes)) return null;
    return url.toString();
  }

  const host = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  const v4 = parseIpv4(host);
  if (v4) return isPrivateIpv4(v4) ? null : url.toString();
  if (/^\d+(?:\.\d+)*$/.test(host)) return null;
  if (!host.includes(".")) return null;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return null;
  return url.toString();
}

function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "authorization" || lower === "proxy-authorization") return true;
  if (lower.includes("cookie")) return true;
  if (lower.startsWith("x-hub-signature")) return true;
  if (
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("password") ||
    lower.includes("key")
  ) {
    return true;
  }
  return false;
}

/** Drops credentials/signature/auth headers and caps the serialized result at 8 KB. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers || typeof headers !== "object") return result;
  for (const [name, rawValue] of Object.entries(headers)) {
    if (typeof name !== "string" || !name) continue;
    if (isSensitiveHeader(name)) continue;
    const value = typeof rawValue === "string" ? rawValue : String(rawValue);
    const candidate = { ...result, [name]: value };
    if (encoder.encode(JSON.stringify(candidate)).byteLength > AUTOMATION_LIMITS.maxHeadersBytes) {
      continue;
    }
    Object.defineProperty(result, name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function validateHeaders(headers: unknown): string | null {
  if (headers === undefined) return null;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return "invalid_headers";
  }
  let bytes = 0;
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof name !== "string" || !name || typeof value !== "string") {
      return "invalid_headers";
    }
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) return "invalid_headers";
    bytes += encoder.encode(name).byteLength + encoder.encode(value).byteLength;
  }
  if (bytes > AUTOMATION_LIMITS.maxHeadersBytes) return "headers_too_large";
  return null;
}

/** Null when the watch source is usable, otherwise a short reason. */
export function validateWatchSource(source: WatchSource): string | null {
  const value = source as unknown as Record<string, unknown>;
  if (!value || typeof value !== "object" || value.type !== "watch") return "invalid_source";
  if (typeof value.url !== "string" || safeFetchUrl(value.url) === null) return "invalid_url";
  const interval = value.interval_minutes;
  if (typeof interval !== "number" || !Number.isFinite(interval)) return "invalid_interval";
  if (interval < AUTOMATION_LIMITS.watchMinIntervalMinutes) return "interval_too_small";
  if (value.fire_on_first !== undefined && typeof value.fire_on_first !== "boolean") {
    return "invalid_fire_on_first";
  }
  return validateHeaders(value.headers);
}

/** SHA-256 hex of a payload. */
export async function bodyHash(body: Uint8Array | string): Promise<string> {
  const bytes = typeof body === "string" ? encoder.encode(body) : body;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}
