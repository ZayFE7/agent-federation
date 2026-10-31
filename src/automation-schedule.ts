// Pure time, fingerprint, and excerpt helpers for automation watchers and
// schedules. Web APIs only; no SDK or Node-only imports.

import type { ScheduleSource } from "./automation-types.ts";
import { AUTOMATION_LIMITS } from "./automation-types.ts";

export { validateWatchSource } from "./automation-security.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DAY_MS = 24 * 60 * 60 * 1000;
const EXCERPT_BYTES = 4 * 1024;
const DAILY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Next interval tick strictly after now, with a 5-minute floor. */
export function nextIntervalDue(everyMinutes: number, from: number, now: number): number {
  if (!Number.isFinite(now)) throw new Error("now must be a finite timestamp");
  const floor = AUTOMATION_LIMITS.watchMinIntervalMinutes;
  const minutes = Number.isFinite(everyMinutes) ? Math.max(floor, everyMinutes) : floor;
  const interval = minutes * 60_000;
  const base = Number.isFinite(from) ? from : now;
  let due = base + interval;
  if (due <= now) {
    const missed = Math.floor((now - base) / interval) + 1;
    due = base + missed * interval;
  }
  if (due <= now) due = now + interval;
  return due;
}

/** Next UTC occurrence of HH:MM strictly after now (and the previous due time). */
export function nextDailyDue(hhmm: string, from: number, now: number): number {
  const match = DAILY_PATTERN.exec(hhmm);
  if (!match) throw new Error("daily_at must be HH:MM in UTC");
  if (!Number.isFinite(now)) throw new Error("now must be a finite timestamp");
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const anchor = Number.isFinite(from) ? Math.max(from, now) : now;
  const day = new Date(anchor);
  let due = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    hours,
    minutes,
    0,
    0
  );
  if (due <= anchor) due += DAY_MS;
  return due;
}

function stableStringify(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value) ?? "null";
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "bigint":
      return JSON.stringify(value.toString()) ?? "null";
    case "object": {
      if (Array.isArray(value)) {
        return `[${Array.from(value, (item) => stableStringify(item)).join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => {
          const item = record[key];
          return item !== undefined && typeof item !== "function" && typeof item !== "symbol";
        })
        .sort();
      return `{${keys
        .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
        .join(",")}}`;
    }
    default:
      return "null";
  }
}

/** Deterministic JSON: object keys sorted, array order preserved. */
export function stableJson(value: unknown): string {
  return stableStringify(value);
}

function isJsonContentType(contentType: string | null): boolean {
  return typeof contentType === "string" && contentType.toLowerCase().includes("json");
}

function parseJsonBody(
  body: Uint8Array,
  contentType: string | null
): { ok: true; value: unknown } | { ok: false } {
  if (!isJsonContentType(contentType)) return { ok: false };
  try {
    const text = decoder.decode(body).replace(/^\uFEFF/, "");
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Stable sha256 for change detection. JSON is normalized; other bodies hash raw. */
export async function watcherFingerprint(
  body: Uint8Array,
  contentType: string | null
): Promise<string> {
  const parsed = parseJsonBody(body, contentType);
  if (parsed.ok) return sha256Hex(stableJson(parsed.value));
  return sha256Hex(body);
}

function capUtf8(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

/** At most 4 KB of display text, compacted when the body is JSON. */
export function watcherExcerpt(body: Uint8Array, contentType: string | null): string {
  const parsed = parseJsonBody(body, contentType);
  const text = parsed.ok ? stableJson(parsed.value) : decoder.decode(body);
  return capUtf8(text, EXCERPT_BYTES);
}

/** Null when the schedule source is usable, otherwise a short reason. */
export function validateScheduleSource(source: ScheduleSource): string | null {
  const value = source as unknown as Record<string, unknown>;
  if (!value || typeof value !== "object" || value.type !== "schedule") return "invalid_source";
  const hasInterval = value.every_minutes !== undefined && value.every_minutes !== null;
  const hasDaily = value.daily_at !== undefined && value.daily_at !== null;
  if (hasInterval === hasDaily) return "exactly_one_schedule_required";
  if (hasInterval) {
    const interval = value.every_minutes;
    if (typeof interval !== "number" || !Number.isFinite(interval)) return "invalid_interval";
    if (interval < AUTOMATION_LIMITS.watchMinIntervalMinutes) return "interval_too_small";
    return null;
  }
  if (typeof value.daily_at !== "string" || !DAILY_PATTERN.test(value.daily_at)) {
    return "invalid_daily_at";
  }
  return null;
}

/** The first due time for a valid schedule source, or null. */
export function defaultScheduleNext(source: ScheduleSource, now: number): number | null {
  if (!Number.isFinite(now)) return null;
  if (validateScheduleSource(source) !== null) return null;
  const value = source as unknown as Record<string, unknown>;
  if (typeof value.every_minutes === "number") {
    return nextIntervalDue(value.every_minutes, now, now);
  }
  if (typeof value.daily_at === "string") {
    try {
      return nextDailyDue(value.daily_at, now, now);
    } catch {
      return null;
    }
  }
  return null;
}
