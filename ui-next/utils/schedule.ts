import type { Automation, ScheduleSpec, Trigger } from "../types";
import { formatDateTimeTz } from "./time";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const SHORT_TO_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function tzOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t: string) =>
    Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - date.getTime();
}

function zonedYmd(date: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) =>
    Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day") };
}

function zonedWeekday(date: Date, tz: string): number {
  const short = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  }).format(date);
  return SHORT_TO_INDEX[short] ?? 0;
}

export function formatClock(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function nextScheduledRun(
  spec: ScheduleSpec,
  tz: string,
  from: Date = new Date(),
): Date {
  const [hh, mm] = spec.time.split(":").map(Number);
  const { y, m, d } = zonedYmd(from, tz);
  for (let i = 0; i < 10; i += 1) {
    const guess = Date.UTC(y, m - 1, d + i, hh, mm);
    const candidate = new Date(guess - tzOffsetMs(new Date(guess), tz));
    if (candidate.getTime() <= from.getTime()) continue;
    const wd = zonedWeekday(candidate, tz);
    if (spec.freq === "weekdays" && (wd === 0 || wd === 6)) continue;
    if (spec.freq === "weekly" && wd !== (spec.weekday ?? 1)) continue;
    return candidate;
  }
  return from;
}

export function nextWatchRun(
  everyHours: number,
  from: Date = new Date(),
): Date {
  const span = everyHours * 3600_000;
  return new Date(Math.ceil((from.getTime() + 1) / span) * span);
}

export function describeTrigger(trigger: Trigger): string {
  if (trigger.type === "schedule") {
    const { freq, time, weekday } = trigger.schedule;
    const clock = formatClock(time);
    if (freq === "daily") return `Every day at ${clock}`;
    if (freq === "weekdays") return `Weekdays at ${clock}`;
    return `${WEEKDAYS[weekday ?? 1]}s at ${clock}`;
  }
  if (trigger.type === "watch")
    return `Checks a page every ${trigger.everyHours} h`;
  return `On ${trigger.event}`;
}

export function nextRunDate(
  a: Automation,
  from: Date = new Date(),
): Date | null {
  if (!a.enabled) return null;
  if (a.trigger.type === "schedule")
    return nextScheduledRun(a.trigger.schedule, a.timezone, from);
  if (a.trigger.type === "watch")
    return nextWatchRun(a.trigger.everyHours, from);
  return null;
}

export function nextRunLabel(a: Automation): string {
  if (!a.enabled) return a.autoPausedReason ? "Auto-paused" : "Paused";
  const next = nextRunDate(a);
  if (!next) return "Waits for the next event";
  return formatDateTimeTz(next, a.timezone);
}
