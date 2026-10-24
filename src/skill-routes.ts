// Native skill library routes. Skills are global, so the Registry DO owns them.

import { authed } from "./auth.ts";
import { parseSkill } from "./skill-parser.ts";
import type { Env, RegistryStub } from "./types";

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
      parsed.skill.body
    );
    if (!saved) return fail(409, "the skill library is full or the name is taken");
    return json({ ok: true, skill: parsed.skill });
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
