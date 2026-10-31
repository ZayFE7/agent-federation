// Singleton coordinator for durable goals. It owns goal state, the alarm, and
// the real planner/verifier/session adapters. All decisions live in
// GoalSupervisor so they can be tested without the Agents SDK.

import { Agent } from "agents";
import { generateText } from "ai";
import type {
  AgentStub,
  AutonomyAgentStub,
  Env,
  GoalStepCompletion,
  RegistryStub,
} from "./types";
import { toSqlHandle, type SqlTag } from "./sql-handle";
import { GoalStore, type GoalAttentionInput } from "./goal-store";
import type { GoalBudget, GoalRow } from "./goal-types";
import { GoalSupervisor, type CreateGoalInput } from "./goal-supervisor";
import { planGoal, type GoalModel } from "./goal-planner";
import { verifyStep } from "./goal-verifier";
import { createPrimaryModel } from "./provider";
import { copySandboxWorkspace } from "./sandbox-client";

const REGISTRY_NAME = "registry";

export interface GoalCreateRequest {
  title: string;
  brief: string;
  success_criteria: string;
  origin_session_id?: string | null;
  budget?: Partial<GoalBudget>;
}

function goalSessionTitle(title: string): string {
  return `Goal: ${title}`.slice(0, 120);
}

function newSessionId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 26);
}

export class AutonomyAgent extends Agent<Env> implements AutonomyAgentStub {
  private storeCache: GoalStore | null = null;
  private supervisorCache: GoalSupervisor | null = null;

  private store(): GoalStore {
    if (!this.storeCache) {
      const handle = toSqlHandle(this.sql.bind(this) as unknown as SqlTag);
      const store = new GoalStore(handle);
      store.ensureSchema();
      this.storeCache = store;
    }
    return this.storeCache;
  }

  private registry(): RegistryStub {
    return this.env.REGISTRY.get(
      this.env.REGISTRY.idFromName(REGISTRY_NAME)
    ) as unknown as RegistryStub;
  }

  private sessionStub(sessionId: string): AgentStub {
    return this.env.FEDERATION_AGENT.get(
      this.env.FEDERATION_AGENT.idFromName(sessionId)
    ) as unknown as AgentStub;
  }

  private supervisor(): GoalSupervisor {
    if (this.supervisorCache) return this.supervisorCache;
    const model: GoalModel = {
      complete: async (prompt) => {
        const result = await generateText({
          model: createPrimaryModel(this.env),
          prompt,
          temperature: 0.2,
        });
        return {
          text: result.text,
          tokens:
            result.usage && typeof result.usage.totalTokens === "number"
              ? result.usage.totalTokens
              : null,
        };
      },
    };
    this.supervisorCache = new GoalSupervisor({
      store: this.store(),
      now: () => Date.now(),
      id: () => crypto.randomUUID().replace(/-/g, "").slice(0, 12),
      sessions: {
        startGoalStep: (input) => this.sessionStub(input.sessionId).startGoalStep(input),
        abortGoalRun: (sessionId, runId) =>
          this.sessionStub(sessionId).abortGoalRun(sessionId, runId),
      },
      plan: (input) => planGoal(model, input),
      verify: (input) => verifyStep(model, input),
      maxRunning: 2,
    });
    return this.supervisorCache;
  }

  async onStart(): Promise<void> {
    this.store();
    await this.arm(Date.now() + 1000);
  }

  async alarm(): Promise<void> {
    const result = await this.supervisor().tick(Date.now());
    await this.arm(result.nextWakeAt);
  }

  private async arm(when: number | null): Promise<void> {
    if (when === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, when));
  }

  async createGoal(input: GoalCreateRequest): Promise<{ ok: boolean; goal?: GoalRow; error?: string }> {
    const registry = this.registry();
    const origin = input.origin_session_id?.trim() || null;
    if (origin && !(await registry.exists(origin))) {
      return { ok: false, error: "the origin session does not exist" };
    }
    const sessionId = newSessionId();
    const now = Date.now();
    await registry.put({
      id: sessionId,
      title: goalSessionTitle(input.title),
      created_at: now,
      updated_at: now,
      workspace_ref: null,
      unread: 0,
      pinned: 0,
    });
    let workspaceSource = "empty";
    let cleanupNeeded = false;
    try {
      if (origin) {
        const saved = await this.sessionStub(origin).saveWorkspaceForGoal(origin);
        if (!saved.ok) throw new Error(saved.output || "origin snapshot failed");
        const copied = await copySandboxWorkspace(this.env, origin, sessionId);
        if (!copied.ok && copied.reason !== "no_snapshot") {
          throw new Error(copied.error || "workspace copy failed");
        }
        if (copied.ok) {
          cleanupNeeded = true;
          workspaceSource = "copy";
          const seeded = now;
          await this.sessionStub(sessionId).adoptWorkspace(sessionId, {
            key: `ws:tar:${sessionId}`,
            bytes: copied.bytes,
            files: copied.files,
            sha256: copied.sha256,
            updated_at: seeded,
          });
        }
      }
      const goal = await this.supervisor().createGoal({
        title: input.title,
        brief: input.brief,
        success_criteria: input.success_criteria,
        session_id: sessionId,
        origin_session_id: origin,
        workspace_source: workspaceSource,
        budget: input.budget,
      });
      await this.arm(Date.now() + 1000);
      return { ok: true, goal };
    } catch (err) {
      await registry.remove(sessionId);
      if (cleanupNeeded) {
        try {
          await this.sessionStub(sessionId).clearWorkspace(sessionId);
        } catch {
          // Best-effort cleanup; the failed goal was never inserted.
        }
      }
      return { ok: false, error: String(err).slice(0, 300) };
    }
  }

  async completeGoalStep(input: GoalStepCompletion): Promise<void> {
    await this.supervisor().completeStep(input);
    await this.arm(Date.now() + 1000);
  }

  async goalApprovalPending(input: {
    runId: string;
    goalId: string;
    stepId: string;
  }): Promise<void> {
    await this.supervisor().approvalPending(input);
    await this.arm(Date.now() + 1000);
  }

  async getGoal(id: string): Promise<GoalRow | null> {
    return this.store().get(id);
  }

  async listGoals(statuses?: string[], limit = 100): Promise<GoalRow[]> {
    return this.store().list(statuses as never, limit);
  }

  async goalEvents(id: string, after: number | null, limit = 100) {
    return this.store().listEvents(id, after, limit);
  }

  async controlGoal(
    id: string,
    action: "pause" | "resume" | "cancel" | "retry" | "instruct" | "budget",
    note?: string
  ) {
    const result = await this.supervisor().control(id, action, note);
    await this.arm(Date.now() + 1000);
    return result;
  }

  async goalAttention(limit = 50) {
    return this.store().listAttention(limit);
  }

  async readGoalAttention(id: number): Promise<boolean> {
    if (!Number.isInteger(id) || id <= 0) return false;
    return this.store().markAttentionRead(id) !== null;
  }

  async setGlobalPause(paused: boolean): Promise<void> {
    this.store().setMeta("paused", paused ? "1" : "0");
    await this.arm(paused ? null : Date.now() + 1000);
  }

  async globalPaused(): Promise<boolean> {
    return this.store().meta("paused") === "1";
  }

  async blocksDelete(sessionId: string): Promise<boolean> {
    return this.store().activeGoalForSession(sessionId) !== null;
  }

  /** Add a synthetic attention row used by future notification delivery. */
  async addGoalAttention(input: GoalAttentionInput): Promise<void> {
    this.store().addAttention(input);
  }
}
