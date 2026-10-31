// The singleton coordinator for automations. It owns the alarm, the store, and
// the real session/registry adapters. All decisions live in AutomationEngine so
// they can be tested without the Agents SDK.

import { Agent } from "agents";
import type {
  AgentStub,
  AutomationAgentStub,
  AutomationRunCompletion,
  Env,
  RegistryStub,
} from "./types";
import { toSqlHandle, type SqlTag } from "./sql-handle";
import { AutomationStore } from "./automation-store";
import { AutomationEngine, type CreateAutomationResult, type IngestResult } from "./automation-engine";
import type {
  AutomationEventRow,
  AutomationListFilter,
  AutomationRow,
  AutomationRunRow,
  CreateAutomationInput,
  SessionPort,
  UpdateAutomationInput,
} from "./automation-types";
import { encryptSecret, decryptSecret } from "./model-secrets";

const REGISTRY_NAME = "registry";

export interface AutomationAgentCreateInput {
  automationId: string;
  mode: "generic" | "github";
  pathSecret?: string;
  bodyText: string;
  headers: Record<string, string>;
  contentType: string | null;
}

function publicRow(row: AutomationRow): AutomationRow {
  return { ...row, secret_enc: null };
}

export class AutomationAgent extends Agent<Env> implements AutomationAgentStub {
  private storeCache: AutomationStore | null = null;

  private store(): AutomationStore {
    if (!this.storeCache) {
      const handle = toSqlHandle(this.sql.bind(this) as unknown as SqlTag);
      const store = new AutomationStore(handle);
      store.ensureSchema();
      this.storeCache = store;
    }
    return this.storeCache;
  }

  private sessionPort(): SessionPort {
    return {
      exists: async (sessionId: string) => {
        const registry = this.env.REGISTRY.get(
          this.env.REGISTRY.idFromName(REGISTRY_NAME)
        ) as unknown as RegistryStub;
        return registry.exists(sessionId);
      },
      submit: async (input) => {
        const stub = this.env.FEDERATION_AGENT.get(
          this.env.FEDERATION_AGENT.idFromName(input.sessionId)
        ) as unknown as AgentStub;
        try {
          const receipt = await stub.submitTurn(
            input.prompt,
            "primary",
            input.sessionId,
            false,
            undefined,
            {
              kind: "automation",
              automationId: input.automationId,
              runId: input.runId,
            }
          );
          if ("code" in receipt) return { ok: false, error: receipt.code };
          return { ok: true, streamId: receipt.streamId, operationId: receipt.operationId };
        } catch (err) {
          return { ok: false, error: String(err).slice(0, 300) };
        }
      },
      status: async (sessionId: string, streamId: string) => {
        const stub = this.env.FEDERATION_AGENT.get(
          this.env.FEDERATION_AGENT.idFromName(sessionId)
        ) as unknown as AgentStub;
        return stub.turnStatus(sessionId, streamId);
      },
    };
  }

  private engine(): AutomationEngine {
    const key = (this.env.AGENT_API_KEY ?? "").trim();
    return new AutomationEngine({
      store: this.store(),
      sessions: this.sessionPort(),
      fetch: (...args) => fetch(...args),
      now: () => Date.now(),
      id: () => crypto.randomUUID().replace(/-/g, "").slice(0, 12),
      encrypt: (secret) => encryptSecret(key, secret),
      decrypt: (enc) => decryptSecret(key, enc),
    });
  }

  async onStart(): Promise<void> {
    this.store();
    // One tick on a cold start drains any queued event and discovers due
    // watchers. It then arms itself for the real next time.
    await this.arm(Date.now() + 1000);
  }

  async alarm(): Promise<void> {
    const result = await this.engine().tick(Date.now());
    await this.arm(result.nextWakeAt);
  }

  private async arm(when: number | null): Promise<void> {
    if (when === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, when));
  }

  async ingestHook(input: AutomationAgentCreateInput): Promise<IngestResult> {
    const engine = this.engine();
    const result = await engine.ingestHttp({
      automationId: input.automationId,
      mode: input.mode,
      pathSecret: input.pathSecret,
      bodyText: input.bodyText,
      rawBody: new TextEncoder().encode(input.bodyText),
      headers: input.headers,
      contentType: input.contentType,
      now: Date.now(),
    });
    if (result.status === "accepted") await this.arm(Date.now() + 1000);
    return result;
  }

  async createAutomation(input: CreateAutomationInput): Promise<CreateAutomationResult> {
    const result = await this.engine().create(input);
    if (result.ok) await this.arm(Date.now() + 1000);
    return result.automation
      ? { ...result, automation: publicRow(result.automation) }
      : result;
  }

  async listAutomations(filter: AutomationListFilter, limit: number): Promise<AutomationRow[]> {
    return this.store()
      .list(filter, Math.min(Math.max(1, Math.floor(limit)), 200))
      .map(publicRow);
  }

  async getAutomation(id: string): Promise<AutomationRow | null> {
    const row = this.store().get(id);
    return row ? publicRow(row) : null;
  }

  async updateAutomation(id: string, patch: UpdateAutomationInput) {
    const result = await this.engine().update(id, patch);
    return result.automation
      ? { ...result, automation: publicRow(result.automation) }
      : result;
  }

  async automationEvents(id: string, after: number, limit: number): Promise<AutomationEventRow[]> {
    return this.store().listEvents(id, after, Math.min(Math.max(1, limit), 200));
  }

  async automationRuns(id: string, limit: number): Promise<AutomationRunRow[]> {
    return this.store().listRuns(id, Math.min(Math.max(1, limit), 200));
  }

  async controlAutomation(
    id: string,
    action: "pause" | "resume" | "rotate_secret" | "retry_event" | "preview" | "delete",
    note?: string
  ) {
    const result = await this.engine().control(id, action, note);
    if (result.ok) await this.arm(Date.now() + 1000);
    return result;
  }

  async setGlobalPause(paused: boolean): Promise<void> {
    this.store().setMeta("paused", paused ? "1" : "0");
    await this.arm(paused ? null : Date.now() + 1000);
  }

  async globalPaused(): Promise<boolean> {
    return this.store().meta("paused") === "1";
  }

  async automationAttention(limit: number): Promise<AutomationEventRow[]> {
    return this.store().listAttention(Math.min(Math.max(1, limit), 100));
  }

  async completeRun(input: AutomationRunCompletion): Promise<void> {
    await this.engine().completeRun({
      runId: input.runId,
      automationId: input.automationId,
      sessionId: input.sessionId,
      status: input.status,
      ...(input.reply ? { reply: input.reply } : {}),
      ...(input.error ? { error: input.error } : {}),
    });
    await this.arm(Date.now() + 1000);
  }
}
