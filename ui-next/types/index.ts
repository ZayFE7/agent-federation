export type ScreenId =
  | "overview"
  | "chat"
  | "approvals"
  | "goals"
  | "automations"
  | "library"
  | "connections"
  | "capabilities"
  | "memory"
  | "settings"
  | "motion";

export interface Route {
  screen: ScreenId;
  id?: string;
}

export type MascotStateId =
  | "listening"
  | "reading"
  | "writing"
  | "editing"
  | "searching"
  | "running"
  | "approval"
  | "unsure"
  | "done"
  | "oops"
  | "replying"
  | "sleeping"
  | "idle"
  | "waking"
  | "thinking"
  | "curious"
  | "alert"
  | "deep-focus"
  | "offline"
  | "loading";

export type Tone =
  | "neutral"
  | "accent"
  | "healthy"
  | "attention"
  | "danger"
  | "muted";

/* ---------- Conversations ---------- */
export type EventKind =
  | "plan"
  | "search"
  | "read"
  | "tool"
  | "write"
  | "verify"
  | "approval";
export type EventStatus =
  | "done"
  | "running"
  | "failed"
  | "waiting"
  | "attention";

export interface AgentEvent {
  id: string;
  kind: EventKind;
  title: string;
  outcome: string;
  status: EventStatus;
  detail?: string;
  command?: string;
  output?: string;
  retryable?: boolean;
}

export interface Citation {
  n: number;
  label: string;
  source: string;
}

export interface Attachment {
  name: string;
  size: number;
  type: string;
}

export interface Message {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  time: string;
  events?: AgentEvent[];
  citations?: Citation[];
  attachments?: Attachment[];
  simulated?: boolean;
  artifactId?: string;
  approvalId?: string;
  queued?: boolean;
  streaming?: boolean;
}

export type PlanStatus = "done" | "active" | "todo" | "waiting" | "blocked";

export interface PlanStep {
  id: string;
  label: string;
  status: PlanStatus;
}

export interface Conversation {
  id: string;
  title: string;
  pinned: boolean;
  updatedAt: string;
  goalId?: string;
  files: string[];
  plan: PlanStep[];
  messages: Message[];
}

export type ChatScenario =
  | "ready"
  | "running"
  | "approval"
  | "error"
  | "offline"
  | "empty";

export interface QueuedTask {
  id: string;
  conversationId: string;
  text: string;
}

/* ---------- Approvals ---------- */
export interface AffectedItem {
  id: string;
  primary: string;
  secondary: string;
  meta: string;
}

export type ApprovalEdit =
  | { kind: "items" }
  | { kind: "text"; label: string; value: string };

export interface Approval {
  id: string;
  title: string;
  app: string;
  account: string;
  tool: string;
  params: string;
  reversible: boolean;
  reversibleNote: string;
  rationale: string;
  risk: "low" | "medium" | "high";
  affectedLabel: string;
  affected: AffectedItem[];
  excludedNote?: string;
  changes: { label: string; before: string; after: string }[];
  editable?: ApprovalEdit;
  conversationId: string | null;
  goalId?: string;
  status: "pending" | "approved" | "denied";
  requestedAt: string;
  resolvedAt?: string;
  receiptId?: string;
  denyReason?: string;
  excludedIds?: string[];
  editedText?: string;
  fromChat?: boolean;
}

/* ---------- Goals ---------- */
export type GoalStatus =
  | "in-progress"
  | "needs-you"
  | "complete"
  | "paused"
  | "cancelled";

export interface Criterion {
  id: string;
  text: string;
  state: "met" | "partial" | "unmet";
  evidence?: string;
}

export interface GoalActivity {
  id: string;
  time: string;
  text: string;
  tone?: Tone;
}

export interface Goal {
  id: string;
  title: string;
  brief: string;
  status: GoalStatus;
  progress: number;
  criteria: Criterion[];
  plan: PlanStep[];
  activity: GoalActivity[];
  budget: {
    toolCalls: number;
    toolLimit: number;
    minutes: number;
    minuteLimit: number;
  };
  conversationId: string | null;
  blocker?: string;
  error?: string;
  currentStep?: string;
  eta?: string;
  instructions: string[];
  sources: string[];
  updatedAt: string;
  createdAt: string;
}

/* ---------- Automations ---------- */
export interface ScheduleSpec {
  freq: "daily" | "weekdays" | "weekly";
  time: string;
  weekday?: number;
}

export type Trigger =
  | { type: "schedule"; schedule: ScheduleSpec }
  | { type: "watch"; url: string; everyHours: number }
  | { type: "webhook"; source: string; event: string; endpoint: string };

export interface RunRecord {
  id: string;
  time: string;
  result: "success" | "failed" | "skipped";
  note: string;
  simulated?: boolean;
}

export interface Automation {
  id: string;
  name: string;
  instructions: string;
  trigger: Trigger;
  checks: string;
  does: string;
  timezone: string;
  targetChatId: string | null;
  enabled: boolean;
  autoPausedReason?: string;
  lastError?: { message: string; remedy: "choose-chat" | "reconnect" };
  history: RunRecord[];
  createdAt: string;
}

/* ---------- Library ---------- */
export type LibraryKind =
  | "document"
  | "code"
  | "app"
  | "audio"
  | "image"
  | "subtitle"
  | "other";

export interface LibraryItem {
  id: string;
  name: string;
  kind: LibraryKind;
  origin: "blip" | "uploaded";
  originTask?: string;
  conversationId?: string;
  version: number;
  size: number;
  mime: string;
  status: "ready" | "draft" | "needs-review";
  updatedAt: string;
  content?: string;
  dataUrl?: string;
  transcript?: string;
  duration?: string;
  generated?: "cover";
}

/* ---------- Connections ---------- */
export type SyncState = "synced" | "syncing" | "expired" | "error";
export type AppIconKey =
  | "gmail"
  | "calendar"
  | "tasks"
  | "github"
  | "slack"
  | "drive"
  | "dropbox"
  | "figma";

export interface ConnectedAccount {
  id: string;
  email: string;
  label?: string;
  state: SyncState;
  lastSync: string;
}

export interface Scope {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  required?: boolean;
  sensitive?: boolean;
}

export interface AppConnection {
  id: string;
  name: string;
  icon: AppIconKey;
  description: string;
  category: string;
  connected: boolean;
  accounts: ConnectedAccount[];
  scopes: Scope[];
}

export interface McpServer {
  id: string;
  name: string;
  url: string;
  auth: "none" | "oauth" | "header";
  tools: number;
  status: "online" | "degraded" | "offline";
  note?: string;
  addedAt: string;
}

/* ---------- Capabilities ---------- */
export type CapabilityIcon =
  | "memory"
  | "shell"
  | "files"
  | "web"
  | "schedule"
  | "autosave"
  | "snapshot"
  | "subagents"
  | "email"
  | "mcp"
  | "skills"
  | "calendar"
  | "tts";

export interface Capability {
  id: string;
  name: string;
  group: string;
  icon: CapabilityIcon;
  status: "available" | "setup";
  summary: string;
  can: string[];
  boundary: string;
  approval: "always" | "destructive" | "none";
  link?: ScreenId;
  linkLabel?: string;
}

/* ---------- Memory & skills ---------- */
export type MemoryCategory = "preference" | "person" | "project" | "fact";

export interface Memory {
  id: string;
  text: string;
  category: MemoryCategory;
  importance: 1 | 2 | 3;
  origin: string;
  date: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  loading: "loaded" | "on-demand";
  uses: number;
  body: string;
  addedAt: string;
}

/* ---------- Settings ---------- */
export type ThemePref = "light" | "dark" | "system";

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
}

export interface Settings {
  name: string;
  timezone: string;
  theme: ThemePref;
  reduceMotion: "system" | "on" | "off";
  mascotAnimated: boolean;
  model: string;
  providers: Provider[];
  firstRunDismissed: boolean;
}

export type TriggerType = Trigger["type"];
