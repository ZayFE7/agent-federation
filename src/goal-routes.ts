// Authenticated /api/goals family. Goal step turns run through the session DO;
// these routes only manage the coordinator and read the audit.

import { authed } from "./auth.ts";
import type { AutonomyAgentStub, Env } from "./types";
import type { GoalBudget } from "./goal-types";

const PREFIX = "/api/goals";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
function fail(status: number, error: string): Response {
  return json({ ok: false, error }, status);
}
function stub(env: Env): AutonomyAgentStub {
  return env.AUTONOMY.get(env.AUTONOMY.idFromName("autonomy")) as unknown as AutonomyAgentStub;
}
function isGoalId(value: string): boolean {
  return /^[a-z0-9]{8,32}$/.test(value);
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

export async function handleGoals(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
  if (!authed(request, env)) return fail(401, "unauthorized");
  const parts = url.pathname
    .slice(PREFIX.length)
    .split("/")
    .filter((segment) => segment !== "");
  const coordinator = stub(env);

  if (parts.length === 0) {
    if (request.method === "GET") {
      const statuses = url.searchParams.get("status");
      const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 100), 200);
      const goals = await coordinator.listGoals(
        statuses ? statuses.split(",").map((value) => value.trim()).filter(Boolean) : undefined,
        limit
      );
      return json({ ok: true, goals, paused: await coordinator.globalPaused() });
    }
    if (request.method === "POST") {
      const body = await readJson(request);
      if (!body) return fail(400, "invalid JSON body");
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const brief = typeof body.brief === "string" ? body.brief.trim() : "";
      const criteria =
        typeof body.success_criteria === "string" ? body.success_criteria.trim() : "";
      if (!title || !brief || !criteria) {
        return fail(400, "title, brief and success_criteria are required");
      }
      const origin =
        typeof body.origin_session_id === "string" ? body.origin_session_id.trim() : undefined;
      const budget =
        body.budget && typeof body.budget === "object" && !Array.isArray(body.budget)
          ? (body.budget as Partial<GoalBudget>)
          : undefined;
      const result = await coordinator.createGoal({
        title,
        brief,
        success_criteria: criteria,
        ...(origin ? { origin_session_id: origin } : {}),
        ...(budget ? { budget } : {}),
      });
      if (!result.ok) return fail(409, result.error ?? "the goal could not be created");
      return json({ ok: true, goal: result.goal }, 201);
    }
    return fail(405, "method not allowed");
  }

  if (parts.length === 1 && parts[0] === "attention") {
    if (request.method !== "GET") return fail(405, "method not allowed");
    return json({ ok: true, attention: await coordinator.goalAttention(50) });
  }
  if (parts.length === 3 && parts[0] === "attention" && parts[2] === "read") {
    if (request.method !== "POST") return fail(405, "method not allowed");
    const attentionId = Number(parts[1]);
    if (!Number.isInteger(attentionId) || attentionId <= 0) {
      return fail(400, "invalid attention id");
    }
    const read = await coordinator.readGoalAttention(attentionId);
    return read ? json({ ok: true }) : fail(404, "not found");
  }
  if (parts.length === 1 && (parts[0] === "pause-all" || parts[0] === "resume-all")) {
    if (request.method !== "POST") return fail(405, "method not allowed");
    await coordinator.setGlobalPause(parts[0] === "pause-all");
    return json({ ok: true, paused: parts[0] === "pause-all" });
  }

  const id = parts[0];
  if (!isGoalId(id)) return fail(400, "invalid goal id");
  if (parts.length === 1 && request.method === "GET") {
    const goal = await coordinator.getGoal(id);
    if (!goal) return fail(404, "not found");
    return json({ ok: true, goal });
  }
  if (parts.length === 2 && parts[1] === "events" && request.method === "GET") {
    const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
    const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 100), 500);
    return json({ ok: true, events: await coordinator.goalEvents(id, after, limit) });
  }
  if (parts.length === 2 && parts[1] === "control" && request.method === "POST") {
    const body = await readJson(request);
    const action = body?.action;
    if (
      action !== "pause" &&
      action !== "resume" &&
      action !== "cancel" &&
      action !== "retry" &&
      action !== "instruct" &&
      action !== "budget"
    ) {
      return fail(400, "unknown control action");
    }
    let note = typeof body?.note === "string" ? body.note.slice(0, 8000) : undefined;
    if (action === "budget" && body?.budget && typeof body.budget === "object") {
      note = JSON.stringify(body.budget);
    }
    const result = await coordinator.controlGoal(id, action, note);
    return result.ok ? json({ ok: true }) : fail(409, result.error ?? "the action failed");
  }
  return fail(404, "not found");
}
