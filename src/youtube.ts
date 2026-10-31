// YouTube URL handling and WebVTT parsing. Pure and dependency-free so the
// transcript tool and plain-Node tests share one parser.

export interface VttCue {
  start: number;
  end: number;
  text: string;
}

const TIME = /^(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/;

function seconds(h: string, m: string, s: string, ms: string): number {
  return (
    Number(h) * 3600 +
    Number(m) * 60 +
    Number(s) +
    Number(ms) / 1000
  );
}

function cleanLine(line: string): string {
  return line
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cues from a WebVTT file, including auto-caption files with inline timestamps. */
export function parseVtt(vtt: string): VttCue[] {
  const lines = String(vtt || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .split("\n");
  const cues: VttCue[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = TIME.exec(lines[i].trim());
    if (!match) continue;
    const start = seconds(match[1], match[2], match[3], match[4]);
    const end = seconds(match[5], match[6], match[7], match[8]);
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j].trim();
      if (!line || TIME.test(line) || /^NOTE\b/.test(line)) break;
      body.push(line);
      j += 1;
    }
    const text = cleanLine(body.join(" "));
    if (text) cues.push({ start, end, text });
    i = j - 1;
  }
  return cues;
}

/** Plain text with consecutive duplicate cues collapsed. */
export function cuesToText(cues: readonly VttCue[]): string {
  const parts: string[] = [];
  for (const cue of cues) {
    if (parts.length > 0 && parts[parts.length - 1] === cue.text) continue;
    parts.push(cue.text);
  }
  return parts.join("\n").trim();
}

function srtTime(value: number): string {
  const total = Math.max(0, Math.round(value * 1000));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const ms = total % 1000;
  const pad = (n: number, size = 2) => String(n).padStart(size, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

export function cuesToSrt(cues: readonly VttCue[]): string {
  return cues
    .map(
      (cue, index) =>
        `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`
    )
    .join("\n");
}

/** The 11-character video id from a YouTube URL, or null for another host. */
export function videoIdFromUrl(raw: string): string | null {
  const value = String(raw || "").trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0] || "";
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }
  if (host !== "youtube.com" && host !== "music.youtube.com") return null;
  const v = url.searchParams.get("v") || "";
  if (/^[A-Za-z0-9_-]{11}$/.test(v)) return v;
  const short = /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/.exec(url.pathname);
  return short ? short[1] : null;
}

export function youtubeSlug(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "video";
}
