export const DEFAULT_TZ = "America/Los_Angeles";

export const TIMEZONES = [
  { id: "America/Los_Angeles", label: "Pacific Time" },
  { id: "America/New_York", label: "Eastern Time" },
  { id: "Europe/London", label: "London" },
  { id: "Europe/Berlin", label: "Central Europe" },
  { id: "Asia/Tokyo", label: "Tokyo" },
];

function toDate(input: string | Date): Date {
  return typeof input === "string" ? new Date(input) : input;
}

export function tzAbbrev(input: string | Date, tz = DEFAULT_TZ): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "short",
    })
      .formatToParts(toDate(input))
      .find((p) => p.type === "timeZoneName");
    return part?.value ?? tz;
  } catch {
    return tz;
  }
}

export function formatTime(input: string | Date, tz = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(toDate(input));
}

export function formatDay(input: string | Date, tz = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(toDate(input));
}

/** "Mon, Nov 2 · 7:30 AM" */
export function formatDateTime(input: string | Date, tz = DEFAULT_TZ): string {
  return `${formatDay(input, tz)} · ${formatTime(input, tz)}`;
}

/** "Mon, Nov 2 · 7:30 AM PST" */
export function formatDateTimeTz(
  input: string | Date,
  tz = DEFAULT_TZ,
): string {
  return `${formatDateTime(input, tz)} ${tzAbbrev(input, tz)}`;
}

export function formatLongDate(input: string | Date, tz = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(toDate(input));
}

export function formatRelative(input: string, now: Date = new Date()): string {
  const t = new Date(input).getTime();
  if (Number.isNaN(t)) return "";
  const diff = now.getTime() - t;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60000);
  const future = diff < 0;
  if (abs < 60000) return "Just now";
  if (min < 60) return future ? `in ${min} min` : `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return future ? `in ${h} h` : `${h} h ago`;
  if (!future && h < 48) return "Yesterday";
  const d = new Date(t);
  const sameYear = d.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(d);
}

export function greeting(now: Date = new Date(), tz = DEFAULT_TZ): string {
  const h = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hourCycle: "h23",
    }).format(now),
  );
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function nowIso(): string {
  return new Date().toISOString();
}
