// Image, speech, and transcription provider client. One OpenAI-compatible
// surface in front of the user's media router: image generations, speech, and
// Whisper transcriptions. No SDK and no key in code.

import type { Env } from "./types";

export const IMAGE_MODEL = "ag/gemini-3.1-flash-image";
export const TTS_MODEL = "gemini/gemini-3.1-flash-tts-preview";
export const STT_MODEL = "groq/whisper-large-v3";

export const TTS_VOICES = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
] as const;

export type TtsVoice = (typeof TTS_VOICES)[number];

export const IMAGE_SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"] as const;
export const IMAGE_QUALITIES = ["auto", "high", "medium", "low"] as const;
export const IMAGE_BACKGROUNDS = ["auto", "transparent", "opaque"] as const;
export const IMAGE_DETAILS = ["auto", "high", "low"] as const;
export const IMAGE_FORMATS = ["png", "jpeg", "webp"] as const;

export interface GeneratedImage {
  bytes: Uint8Array;
  mime: string;
  ext: string;
  width: number | null;
  height: number | null;
}

export interface GeneratedAudio {
  bytes: Uint8Array;
  mime: string;
  ext: string;
  duration: number | null;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptResult {
  text: string;
  language: string | null;
  duration: number | null;
  segments: TranscriptSegment[];
}

export class MediaError extends Error {}

export function mediaConfigured(env: Env): boolean {
  return Boolean(env.MEDIA_API_BASE_URL?.trim() && env.MEDIA_API_KEY?.trim());
}

function apiBase(env: Env): string {
  const base = env.MEDIA_API_BASE_URL?.trim().replace(/\/+$/, "");
  if (!base) throw new MediaError("The media endpoint is not configured.");
  return base;
}

function authHeaders(env: Env): Record<string, string> {
  const key = env.MEDIA_API_KEY?.trim();
  if (!key) throw new MediaError("The media API key is not configured.");
  return { authorization: `Bearer ${key}` };
}

function errorText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Fall through to the raw body.
  }
  return raw;
}

async function failure(res: Response, label: string): Promise<MediaError> {
  const raw = (await res.text().catch(() => "")).slice(0, 500);
  return new MediaError(`${label} failed (${res.status}): ${errorText(raw) || "no detail"}`);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let value = "";
  for (let i = start; i < end && i < bytes.length; i += 1) value += String.fromCharCode(bytes[i]);
  return value;
}

/** MIME and extension from the bytes, because this endpoint returns JPEG for png. */
export function detectImage(bytes: Uint8Array): { mime: string; ext: string } {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { mime: "image/png", ext: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return { mime: "image/webp", ext: "webp" };
  }
  if (bytes.length >= 6 && ascii(bytes, 0, 3) === "GIF") {
    return { mime: "image/gif", ext: "gif" };
  }
  return { mime: "application/octet-stream", ext: "bin" };
}

/** Width and height for PNG and JPEG, the two shapes this provider returns. */
export function imageDimensions(
  bytes: Uint8Array
): { width: number; height: number } | null {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = bytes[i + 1];
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          height: view.getUint16(i + 5),
          width: view.getUint16(i + 7),
        };
      }
      if (i + 3 >= bytes.length) break;
      const size = view.getUint16(i + 2);
      if (size < 2) break;
      i += 2 + size;
    }
  }
  return null;
}

export function detectAudio(bytes: Uint8Array): { mime: string; ext: string } {
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE") {
    return { mime: "audio/wav", ext: "wav" };
  }
  if (bytes.length >= 3 && ascii(bytes, 0, 3) === "ID3") {
    return { mime: "audio/mpeg", ext: "mp3" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return { mime: "audio/mpeg", ext: "mp3" };
  }
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "OggS") {
    return { mime: "audio/ogg", ext: "ogg" };
  }
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "fLaC") {
    return { mime: "audio/flac", ext: "flac" };
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") {
    return { mime: "audio/mp4", ext: "m4a" };
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { mime: "audio/webm", ext: "webm" };
  }
  return { mime: "application/octet-stream", ext: "bin" };
}

/** Seconds in a PCM WAV, or null for anything else. */
export function wavDuration(bytes: Uint8Array): number | null {
  if (bytes.length < 44 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 12) !== "WAVE") {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt " && offset + 16 <= bytes.length) {
      byteRate = view.getUint32(offset + 16, true);
    }
    if (id === "data") {
      dataSize = Math.min(size, bytes.length - offset - 8);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!byteRate || !dataSize) return null;
  return dataSize / byteRate;
}

export function formatTimestamp(seconds: number, comma: boolean): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${comma ? "," : "."}${pad(millis, 3)}`;
}

export function buildSrt(segments: readonly TranscriptSegment[]): string {
  return segments
    .map(
      (segment, index) =>
        `${index + 1}\n${formatTimestamp(segment.start, true)} --> ${formatTimestamp(
          segment.end,
          true
        )}\n${segment.text.trim()}\n`
    )
    .join("\n");
}

export function buildVtt(segments: readonly TranscriptSegment[]): string {
  const body = segments
    .map(
      (segment) =>
        `${formatTimestamp(segment.start, false)} --> ${formatTimestamp(segment.end, false)}\n${segment.text.trim()}\n`
    )
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

export interface ImageInput {
  prompt: string;
  size?: (typeof IMAGE_SIZES)[number];
  quality?: (typeof IMAGE_QUALITIES)[number];
  background?: (typeof IMAGE_BACKGROUNDS)[number];
  detail?: (typeof IMAGE_DETAILS)[number];
  format?: (typeof IMAGE_FORMATS)[number];
}

/** One image request. The router returns one image even when n is larger. */
export async function generateImage(env: Env, input: ImageInput): Promise<GeneratedImage[]> {
  const res = await fetch(`${apiBase(env)}/images/generations`, {
    method: "POST",
    headers: { ...authHeaders(env), "content-type": "application/json" },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt: input.prompt,
      n: 1,
      size: input.size ?? "auto",
      quality: input.quality ?? "auto",
      background: input.background ?? "auto",
      image_detail: input.detail ?? "high",
      output_format: input.format ?? "png",
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw await failure(res, "Image generation");
  const data = (await res.json().catch(() => null)) as {
    data?: Array<{ b64_json?: unknown; url?: unknown }>;
  } | null;
  const items = Array.isArray(data?.data) ? data.data : [];
  const images: GeneratedImage[] = [];
  for (const item of items) {
    let bytes: Uint8Array | null = null;
    if (typeof item.b64_json === "string" && item.b64_json) {
      bytes = decodeBase64(item.b64_json);
    } else if (typeof item.url === "string" && /^https?:\/\//i.test(item.url)) {
      const imageRes = await fetch(item.url, { signal: AbortSignal.timeout(60_000) });
      if (imageRes.ok) bytes = new Uint8Array(await imageRes.arrayBuffer());
    }
    if (!bytes || bytes.length === 0) continue;
    const detected = detectImage(bytes);
    const dims = imageDimensions(bytes);
    images.push({
      bytes,
      ...detected,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
    });
  }
  if (images.length === 0) {
    throw new MediaError("The image model returned no image.");
  }
  return images;
}

export interface SpeechInput {
  text: string;
  voice?: TtsVoice;
}

/** The router answers audio/wav today, even when mp3 is requested. */
export async function generateSpeech(env: Env, input: SpeechInput): Promise<GeneratedAudio> {
  const res = await fetch(`${apiBase(env)}/audio/speech`, {
    method: "POST",
    headers: { ...authHeaders(env), "content-type": "application/json" },
    body: JSON.stringify({
      model: TTS_MODEL,
      input: input.text,
      voice: input.voice ?? "Zephyr",
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw await failure(res, "Speech generation");
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/json")) {
    const raw = (await res.text()).slice(0, 500);
    throw new MediaError(`Speech generation failed: ${errorText(raw)}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) throw new MediaError("The speech model returned no audio.");
  const detected = detectAudio(bytes);
  return {
    bytes,
    ...detected,
    duration: wavDuration(bytes),
  };
}

export interface TranscriptionInput {
  bytes: Uint8Array;
  filename: string;
  mime?: string;
  language?: string;
}

export async function transcribeMedia(
  env: Env,
  input: TranscriptionInput
): Promise<TranscriptResult> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([input.bytes], { type: input.mime || "application/octet-stream" }),
    input.filename
  );
  form.append("model", STT_MODEL);
  form.append("response_format", "verbose_json");
  if (input.language?.trim()) form.append("language", input.language.trim());

  const res = await fetch(`${apiBase(env)}/audio/transcriptions`, {
    method: "POST",
    headers: authHeaders(env),
    body: form,
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw await failure(res, "Transcription");
  const data = (await res.json().catch(() => null)) as {
    text?: unknown;
    language?: unknown;
    duration?: unknown;
    segments?: Array<{ start?: unknown; end?: unknown; text?: unknown }>;
  } | null;
  if (!data || typeof data.text !== "string") {
    throw new MediaError("The transcription service returned no text.");
  }
  const segments: TranscriptSegment[] = Array.isArray(data.segments)
    ? data.segments.flatMap((segment) => {
        const start = Number(segment.start);
        const end = Number(segment.end);
        const text = typeof segment.text === "string" ? segment.text : "";
        if (!Number.isFinite(start) || !Number.isFinite(end) || !text.trim()) return [];
        return [{ start, end, text }];
      })
    : [];
  return {
    text: data.text,
    language: typeof data.language === "string" ? data.language : null,
    duration: typeof data.duration === "number" ? data.duration : null,
    segments,
  };
}
