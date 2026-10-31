// Fetch and unpack skill packages from a URL, GitHub, or a zip archive.
// fflate is worker-safe and dependency-light; no Node fs or child process.

import { unzipSync } from "fflate";
import { parseSkill } from "./skill-parser.ts";
import type { SkillPackage, SkillPackageFile } from "./types";

const MAX_ARCHIVE_BYTES = 12 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 80 * 1024 * 1024;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_SKILLS_PER_IMPORT = 20;

export interface SkillImportSkipped {
  path: string;
  reason: string;
}

export type SkillImportResult =
  | { ok: true; packages: SkillPackage[]; skipped: SkillImportSkipped[] }
  | { ok: false; error: string };

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function privateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h === "::1" ||
    h.endsWith(".local") ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h)
  );
}

function publicHttps(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (privateHost(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

function safePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

function filesUnder(
  entries: Record<string, Uint8Array>,
  root: string,
  source: string
): { files: SkillPackageFile[]; body: string } | null {
  const skillMd = entries[`${root}SKILL.md`] ?? entries[`${root}skill.md`];
  if (!skillMd) return null;
  const bodyText = new TextDecoder().decode(skillMd);
  // Some zips carry directory entries as zero-byte names without a trailing
  // slash. Writing one of those as a file then fails over its children, so a
  // zero-byte name that prefixes another entry is treated as a directory.
  const dirs = new Set<string>();
  for (const path of Object.keys(entries)) {
    let at = path.indexOf("/");
    while (at !== -1) {
      dirs.add(path.slice(0, at));
      at = path.indexOf("/", at + 1);
    }
  }
  const files: SkillPackageFile[] = [];
  for (const [path, bytes] of Object.entries(entries)) {
    if (path === "" || path.endsWith("/")) continue;
    if (!path.startsWith(root)) continue;
    if (bytes.length === 0 && dirs.has(path)) continue;
    const relative = safePath(path.slice(root.length));
    if (!relative) continue;
    if (relative.startsWith("__MACOSX/") || relative.startsWith(".git/")) continue;
    files.push({ path: relative, bytes: bytes.length, contentBase64: base64(bytes) });
  }
  return { files, body: bodyText };
}

/** Every SKILL.md root in a zip becomes one package. */
export function packagesFromZip(
  bytes: Uint8Array,
  source: string,
  pathFilter = ""
): SkillImportResult {
  if (bytes.length > MAX_ARCHIVE_BYTES) return { ok: false, error: "the archive is too large" };
  // Read the central directory before decompressing anything: a small zip can
  // claim gigabytes. The filter pass allocates nothing and reports the sizes.
  let totalRaw = 0;
  let entryCount = 0;
  let oversized = "";
  try {
    unzipSync(bytes, {
      filter: (file) => {
        entryCount++;
        totalRaw += file.originalSize;
        if (file.originalSize > MAX_ENTRY_BYTES && !oversized) oversized = file.name;
        return false;
      },
    });
  } catch {
    return { ok: false, error: "the archive could not be read as a zip" };
  }
  if (oversized) {
    return { ok: false, error: `${oversized} expands to over 8 MB; that package is too large` };
  }
  if (totalRaw > MAX_UNPACKED_BYTES) {
    return { ok: false, error: "the archive expands to more than 80 MB" };
  }
  if (entryCount > MAX_ENTRIES) {
    return { ok: false, error: `the archive has more than ${MAX_ENTRIES} entries` };
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return { ok: false, error: "the archive could not be read as a zip" };
  }
  const filter = safePath(pathFilter).replace(/\/+$/, "");
  const prefixed: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(entries)) {
    const clean = safePath(path);
    if (filter) {
      // A GitHub codeload zip nests everything under `<repo>-<branch>/`, while
      // a tree URL names the folder from the repository root. Match the filter
      // at a segment boundary and store what is inside it.
      const at = clean.indexOf(`${filter}/`);
      if (at < 0) continue;
      if (at > 0 && clean[at - 1] !== "/") continue;
      prefixed[clean.slice(at + filter.length).replace(/^\/+/, "")] = data;
    } else {
      prefixed[clean] = data;
    }
  }
  const roots = new Set<string>();
  for (const path of Object.keys(prefixed)) {
    const match = /^(.*?)(?:^|\/)SKILL\.md$/i.exec(path);
    if (match) {
      const raw = match[1] || "";
      roots.add(raw ? `${raw.replace(/\/+$/, "")}/` : "");
    }
  }
  if (roots.size === 0) return { ok: false, error: "the archive has no SKILL.md" };
  const packages: SkillPackage[] = [];
  const skipped: SkillImportSkipped[] = [];
  let seen = 0;
  for (const root of roots) {
    if (seen >= MAX_SKILLS_PER_IMPORT) {
      skipped.push({ path: root || "SKILL.md", reason: `over the ${MAX_SKILLS_PER_IMPORT}-skill import cap` });
      continue;
    }
    seen++;
    const found = filesUnder(prefixed, root, source);
    if (!found) {
      skipped.push({ path: root || "SKILL.md", reason: "the folder has no readable SKILL.md" });
      continue;
    }
    const folder = root.replace(/\/+$/, "").split("/").pop() || "";
    const parsed = parseSkill(found.body, folder);
    if (!parsed.ok) {
      skipped.push({ path: root || "SKILL.md", reason: parsed.error });
      continue;
    }
    packages.push({
      name: parsed.skill.name,
      description: parsed.skill.description,
      body: parsed.skill.body,
      source,
      files: found.files,
    });
  }
  if (packages.length === 0) {
    return {
      ok: false,
      error:
        "SKILL.md was found, but no package was valid" +
        (skipped.length ? `: ${skipped[0].reason}` : ""),
    };
  }
  return { ok: true, packages, skipped };
}

async function fetchBytes(url: URL): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: { accept: "application/zip,text/markdown,text/plain,*/*" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`download returned HTTP ${res.status}`);
  const length = Number(res.headers.get("content-length") || 0);
  if (length > MAX_ARCHIVE_BYTES) throw new Error("the download is too large");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("the download is too large");
  return bytes;
}

function githubZip(url: URL): { codeload: URL[]; path: string } | null {
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo, kind, branch, ...rest] = parts;
  const path = kind === "tree" ? rest.join("/") : "";
  const branches = kind === "tree" && branch ? [branch] : ["main", "master"];
  return {
    codeload: branches.map(
      (b) => new URL(`https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${b}`)
    ),
    path,
  };
}

/** Download one source and return every skill package inside it. */
export async function fetchSkillPackages(
  rawUrl: string,
  pathFilter = ""
): Promise<SkillImportResult> {
  const url = publicHttps(rawUrl);
  if (!url) return { ok: false, error: "skill source must be a public HTTPS URL" };
  try {
    const gh = githubZip(url);
    if (gh) {
      for (const candidate of gh.codeload) {
        try {
          const bytes = await fetchBytes(candidate);
          return packagesFromZip(bytes, url.href, pathFilter || gh.path);
        } catch {
          // Try the next default branch before giving up.
        }
      }
      return { ok: false, error: "could not download that GitHub repository" };
    }
    const bytes = await fetchBytes(url);
    const isMarkdown =
      url.pathname.toLowerCase().endsWith(".md") ||
      url.hostname === "raw.githubusercontent.com";
    if (isMarkdown) {
      const text = new TextDecoder().decode(bytes);
      const parsed = parseSkill(text, url.pathname.split("/").pop()?.replace(/\.md$/i, "") || "");
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return {
        ok: true,
        packages: [
          {
            name: parsed.skill.name,
            description: parsed.skill.description,
            body: parsed.skill.body,
            source: url.href,
            files: [
              {
                path: "SKILL.md",
                bytes: bytes.length,
                contentBase64: base64(bytes),
              },
            ],
          },
        ],
        skipped: [],
      };
    }
    return packagesFromZip(bytes, url.href, pathFilter);
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 300) };
  }
}
