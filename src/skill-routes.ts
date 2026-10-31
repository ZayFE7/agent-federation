// Native skill library routes. Skills are global, so the Registry DO owns them.

import { authed } from "./auth.ts";
import { parseSkill } from "./skill-parser.ts";
import { decodeBase64, fetchSkillPackages, packagesFromZip } from "./skill-import.ts";
import { zipSync } from "fflate";
import type { Env, RegistryStub, SkillPackage } from "./types";

const PREFIX = "/api/skills";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function fail(status: number, error: string): Response {
  return json({ ok: false, error }, status);
}

function registryStubFor(env: Env): RegistryStub {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
  return stub as unknown as RegistryStub;
}

export async function handleSkills(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
  if (!authed(request, env)) return fail(401, "unauthorized");
  const registry = registryStubFor(env);
  const parts = url.pathname.slice(PREFIX.length).split("/").filter(Boolean);

  if (parts.length === 0 && request.method === "GET") {
    return json({ ok: true, skills: await registry.skillCatalog() });
  }

  if (parts.length === 0 && request.method === "POST") {
    let body: { text?: unknown; name?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return fail(400, "invalid JSON body");
    }
    if (typeof body.text !== "string") return fail(400, "text required");
    const parsed = parseSkill(body.text, typeof body.name === "string" ? body.name : "");
    if (!parsed.ok) return fail(400, parsed.error);
    const saved = await registry.skillSave(
      parsed.skill.name,
      parsed.skill.description,
      parsed.skill.body,
      [],
      "manual"
    );
    if (!saved) return fail(409, "the skill library is full or the name is taken");
    return json({ ok: true, skill: parsed.skill });
  }

  if (parts.length === 1 && parts[0] === "import" && request.method === "POST") {
    let body: { url?: unknown; archiveBase64?: unknown; path?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return fail(400, "invalid JSON body");
    }
    const path = typeof body.path === "string" ? body.path : "";
    let packages: SkillPackage[];
    let skipped: Array<{ path: string; reason: string }> = [];
    let source = "manual";
    if (typeof body.url === "string" && body.url.trim()) {
      source = body.url.trim();
      const fetched = await fetchSkillPackages(source, path);
      if (!fetched.ok) return fail(400, fetched.error);
      packages = fetched.packages;
      skipped = fetched.skipped;
    } else if (typeof body.archiveBase64 === "string" && body.archiveBase64) {
      // 12 MB of zip is about 16.8 MB as base64; the headroom covers the JSON
      // envelope while the importer still enforces the real archive cap.
      if (body.archiveBase64.length > 20 * 1024 * 1024) {
        return fail(413, "the archive is too large");
      }
      source = "upload";
      const unpacked = packagesFromZip(decodeBase64(body.archiveBase64), "upload", path);
      if (!unpacked.ok) return fail(400, unpacked.error);
      packages = unpacked.packages;
      skipped = unpacked.skipped;
    } else {
      return fail(400, "url or archiveBase64 required");
    }
    const installed = [];
    for (const skill of packages) {
      const saved = await registry.skillSave(
        skill.name,
        skill.description,
        skill.body,
        skill.files,
        skill.source
      );
      if (!saved) {
        return fail(
          409,
          `could not save ${skill.name}; the library may be full or a file exceeds the size limit`
        );
      }
      installed.push({
        name: skill.name,
        description: skill.description,
        files: skill.files.length,
        bytes: skill.files.reduce((sum, file) => sum + file.bytes, 0),
        source: skill.source,
      });
    }
    return json({ ok: true, skills: installed, packages: packages.length, skipped });
  }

  if (parts.length === 2 && parts[1] === "archive" && request.method === "GET") {
    let name: string;
    try {
      name = decodeURIComponent(parts[0]);
    } catch {
      return fail(404, "not found");
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(name)) return fail(404, "not found");
    const files = await registry.skillFiles(name);
    if (!files) return fail(404, "not found");
    const zipEntries: Record<string, Uint8Array> = {};
    for (const file of files) {
      zipEntries[file.path] = decodeBase64(file.contentBase64);
    }
    const zipped = zipSync(zipEntries, { level: 6 });
    return new Response(zipped, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${name}.zip"`,
        "cache-control": "no-store",
      },
    });
  }

  if (parts.length === 1) {
    let name: string;
    try {
      name = decodeURIComponent(parts[0]);
    } catch {
      return fail(404, "not found");
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(name)) return fail(404, "not found");
    if (request.method === "GET") {
      const skill = await registry.skillGet(name);
      if (!skill) return fail(404, "not found");
      return json({ ok: true, skill });
    }
    if (request.method === "DELETE") {
      if (!(await registry.skillDelete(name))) return fail(404, "not found");
      return json({ ok: true });
    }
  }

  return fail(404, "not found");
}
