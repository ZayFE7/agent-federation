import type { LibraryKind } from "../types";

const CODE_EXT = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "py",
  "css",
  "sh",
  "go",
  "rs",
  "yml",
  "yaml",
];
const DOC_EXT = ["md", "txt", "pdf", "doc", "docx", "rtf", "csv"];

export function extension(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function inferKind(name: string, mime: string): LibraryKind {
  const ext = extension(name);
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (ext === "html" || ext === "htm") return "app";
  if (ext === "srt" || ext === "vtt") return "subtitle";
  if (CODE_EXT.includes(ext)) return "code";
  if (DOC_EXT.includes(ext) || mime.startsWith("text/")) return "document";
  return "other";
}

export function isTextLike(name: string, mime: string): boolean {
  const kind = inferKind(name, mime);
  return (
    mime.startsWith("text/") ||
    (["document", "code", "app", "subtitle"].includes(kind) &&
      extension(name) !== "pdf")
  );
}

export function downloadBlob(
  filename: string,
  data: Blob | string,
  mime = "text/plain",
): void {
  const blob =
    typeof data === "string"
      ? new Blob([data], { type: `${mime};charset=utf-8` })
      : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
