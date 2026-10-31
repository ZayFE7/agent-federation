// Public webhook ingress and the authenticated /api/automations family.
// Public hooks are validated per automation inside the DO; management routes
// use the same bearer as every other console route.

import { authed } from "./auth.ts";
import {
  AUTOMATION_LIMITS,
  isAutomationId,
  isAutomationKind,
  type AutomationKind,
  type AutomationListFilter,
  type AutomationRow,
  type AutomationSource,
  type AutomationStatus,
  type CreateAutomationInput,
  type MatchNode,
  type UpdateAutomationInput,
} from "./automation-types.ts";
import type { AutomationAgentStub, Env } from "./types";

const API_PREFIX = "/api/automations";
const HOOKS_PREFIX = "/hooks/";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function fail(status: number, error: string): Response {
  return json({ ok: false, error }, status);
}

function automationStub(env: Env): AutomationAgentStub {
  const stub = env.AUTOMATION.get(env.AUTOMATION.idFromName("automation"));
  return stub as unknown as AutomationAgentStub;
}

/** Never send the encrypted secret, even to the owner's browser. */
function publicAutomation(row: AutomationRow): AutomationRow {
  const safe = { ...row };
  delete (safe as unknown as { secret_enc?: string | null }).secret_enc;
  return safe;
}

function statusOf(value: string | null): AutomationStatus | undefined {
  return value === "active" || value === "paused" || value === "auto_paused" ? value : undefined;
}

function kindOf(value: string | null): AutomationKind | undefined {
  return isAutomationKind(value) ? value : undefined;
}

function isSource(value: unknown): value is AutomationSource {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "webhook" || type === "watch" || type === "schedule";
}

function isMatch(value: unknown): value is MatchNode {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * POST /hooks/:id/:secret for generic webhooks.
 * POST /hooks/:id for GitHub HMAC.
 */
export async function handleAutomationHooks(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(HOOKS_PREFIX)) return null;
  if (request.method !== "POST") return fail(405, "method not allowed");
  const parts = url.pathname.slice(1).split("/").filter((segment) => segment !== "");
  if (parts.length < 2 || parts.length > 3 || parts[0] !== "hooks") {
    return fail(404, "not found");
  }
  const id = parts[1];
  if (!isAutomationId(id)) return fail(404, "not found");
  const pathSecret = parts.length === 3 ? parts[2] : undefined;

  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > AUTOMATION_LIMITS.maxBodyBytes) {
    return fail(413, "the event body is too large");
  }
  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return fail(400, "the event body could not be read");
  }
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const result = await automationStub(env).ingestHook({
    automationId: id,
    mode: pathSecret ? "generic" : "github",
    ...(pathSecret ? { pathSecret } : {}),
    bodyText,
    headers,
    contentType: request.headers.get("content-type"),
  });
  switch (result.status) {
    case "accepted":
      return json({ ok: true, eventId: result.eventId, ...(result.reason ? { reason: result.reason } : {}) }, 202);
    case "duplicate":
      return json({ ok: true, duplicate: true, eventId: result.eventId });
    case "invalid":
      return fail(401, "unauthorized");
    case "not_found":
      return fail(404, "not found");
    case "too_large":
      return fail(413, "the event body is too large");
    case "rate_limited":
      return json({ ok: true, rateLimited: true, eventId: result.eventId, reason: result.reason }, 429);
    case "disabled":
    case "skipped":
      return json({ ok: true, skipped: true, eventId: result.eventId, reason: result.reason }, 202);
    default:
      return fail(500, "the automation refused the event");
  }
}

/** GET/POST/DELETE /api/automations* */
export async function handleAutomations(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) return null;
  if (!authed(request, env)) return fail(401, "unauthorized");

  const parts = url.pathname
    .slice(API_PREFIX.length)
    .split("/")
    .filter((segment) => segment !== "");

  if (parts.length === 0) {
    if (request.method === "GET") {
      const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 100), 200);
      const filter: AutomationListFilter = {
        ...(statusOf(url.searchParams.get("status")) ? { status: statusOf(url.searchParams.get("status"))! } : {}),
        ...(kindOf(url.searchParams.get("kind")) ? { kind: kindOf(url.searchParams.get("kind"))! } : {}),
      };
      const stub = automationStub(env);
      const automations = await stub.listAutomations(filter, limit);
      return json({
        ok: true,
        automations: automations.map(publicAutomation),
        paused: await stub.globalPaused(),
      });
    }
    if (request.method === "POST") return createAutomation(request, env);
    return fail(405, "method not allowed");
  }

  if (parts.length === 1 && parts[0] === "attention") {
    if (request.method !== "GET") return fail(405, "method not allowed");
    const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 50), 100);
    return json({ ok: true, attention: await automationStub(env).automationAttention(limit) });
  }
  if (parts.length === 1 && (parts[0] === "pause-all" || parts[0] === "resume-all")) {
    if (request.method !== "POST") return fail(405, "method not allowed");
    await automationStub(env).setGlobalPause(parts[0] === "pause-all");
    return json({ ok: true, paused: parts[0] === "pause-all" });
  }

  const id = parts[0];
  if (!isAutomationId(id)) return fail(400, "invalid automation id");
  const stub = automationStub(env);
  if (parts.length === 1) {
    if (request.method === "GET") {
      const automation = await stub.getAutomation(id);
      if (!automation) return fail(404, "not found");
      return json({ ok: true, automation: publicAutomation(automation) });
    }
    if (request.method === "PATCH") {
      const body = await readJson(request);
      if (!body) return fail(400, "invalid JSON body");
      const patch: UpdateAutomationInput = {};
      if (typeof body.name === "string") patch.name = body.name;
      if (typeof body.instructions === "string") patch.instructions = body.instructions;
      if (typeof body.target_session_id === "string") patch.target_session_id = body.target_session_id;
      if (typeof body.cooldown_ms === "number") patch.cooldown_ms = body.cooldown_ms;
      if (typeof body.max_per_hour === "number") patch.max_per_hour = body.max_per_hour;
      if (body.match !== undefined) {
        if (body.match !== null && !isMatch(body.match)) return fail(400, "invalid match");
        patch.match = body.match as MatchNode | null;
      }
      if (Object.keys(patch).length === 0) return fail(400, "nothing to update");
      const result = await stub.updateAutomation(id, patch);
      if (!result.ok || !result.automation) return fail(409, result.error ?? "could not update");
      return json({ ok: true, automation: publicAutomation(result.automation) });
    }
    if (request.method === "DELETE") {
      const result = await stub.controlAutomation(id, "delete");
      return result.ok ? json({ ok: true }) : fail(404, result.error ?? "not found");
    }
    return fail(405, "method not allowed");
  }
  if (parts.length === 2 && parts[1] === "events" && request.method === "GET") {
    const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
    const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 50), 200);
    return json({ ok: true, events: await stub.automationEvents(id, after, limit) });
  }
  if (parts.length === 2 && parts[1] === "runs" && request.method === "GET") {
    const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 50), 200);
    return json({ ok: true, runs: await stub.automationRuns(id, limit) });
  }
  if (parts.length === 2 && parts[1] === "control" && request.method === "POST") {
    const body = await readJson(request);
    const action = body?.action;
    if (
      action !== "pause" &&
      action !== "resume" &&
      action !== "rotate_secret" &&
      action !== "retry_event" &&
      action !== "preview"
    ) {
      return fail(400, "unknown control action");
    }
    const note =
      typeof body?.note === "string" ? body.note.slice(0, 500) : undefined;
    const result = await stub.controlAutomation(id, action, note);
    if (!result.ok) return fail(409, result.error ?? "the action failed");
    const automation = await stub.getAutomation(id);
    if (action === "rotate_secret" && result.secret && automation) {
      const secret = result.secret;
      return json({
        ok: true,
        secret,
        webhookPath: `/hooks/${automation.id}/${secret}`,
        githubPath: `/hooks/${automation.id}`,
      });
    }
    return json({ ok: true, ...(result.prompt ? { prompt: result.prompt } : {}) });
  }
  return fail(404, "not found");
}

async function createAutomation(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body) return fail(400, "invalid JSON body");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
  const kind = body.kind;
  const target = typeof body.target_session_id === "string" ? body.target_session_id.trim() : "main";
  const source = body.source;
  if (!name || !instructions) return fail(400, "name and instructions are required");
  if (!isAutomationKind(kind)) return fail(400, "invalid automation kind");
  if (!isSource(source)) return fail(400, "invalid source");
  if (body.match !== undefined && body.match !== null && !isMatch(body.match)) {
    return fail(400, "invalid match");
  }
  const cooldown =
    typeof body.cooldown_ms === "number" && Number.isFinite(body.cooldown_ms)
      ? Math.max(1000, Math.min(3_600_000, Math.floor(body.cooldown_ms)))
      : undefined;
  const maxPerHour =
    typeof body.max_per_hour === "number" && Number.isFinite(body.max_per_hour)
      ? Math.max(1, Math.min(100, Math.floor(body.max_per_hour)))
      : undefined;
  const input: CreateAutomationInput = {
    name,
    instructions,
    kind,
    target_session_id: target,
    source,
    ...(body.match !== undefined && body.match !== null ? { match: body.match } : {}),
    ...(cooldown !== undefined ? { cooldown_ms: cooldown } : {}),
    ...(maxPerHour !== undefined ? { max_per_hour: maxPerHour } : {}),
  };
  const result = await automationStub(env).createAutomation(input);
  if (!result.ok || !result.automation) return fail(400, result.error ?? "could not create");
  const automation = result.automation;
  const secret = result.secret;
  return json(
    {
      ok: true,
      automation: publicAutomation(automation),
      ...(secret
        ? {
            secret,
            webhookPath: `/hooks/${automation.id}/${secret}`,
            githubPath: `/hooks/${automation.id}`,
          }
        : {}),
    },
    201
  );
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const raw = await request.text();
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
