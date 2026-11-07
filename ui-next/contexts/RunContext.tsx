import React, {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import type {
  AgentEvent,
  Approval,
  Attachment,
  Conversation,
  LibraryItem,
  MascotStateId,
  Message,
  QueuedTask,
} from "../types";
import { useApp } from "./AppContext";
import { promoThreads } from "../data/approvals";
import { nowIso } from "../utils/time";
import { receiptCode, slugify, truncate, uid } from "../utils/format";

export type RunPhase =
  | "planning"
  | "searching"
  | "writing"
  | "verifying"
  | "approval"
  | "done";
export type AgentStatus = "ready" | "running" | "waiting" | "offline";

export interface RunState {
  conversationId: string;
  messageId: string;
  phase: RunPhase;
}

export const PHASE_MASCOT: Record<RunPhase, MascotStateId> = {
  planning: "thinking",
  searching: "searching",
  writing: "writing",
  verifying: "reading",
  approval: "approval",
  done: "done",
};

export const PHASE_LABEL: Record<RunPhase, string> = {
  planning: "Planning",
  searching: "Searching",
  writing: "Working with tools",
  verifying: "Verifying",
  approval: "Waiting for your approval",
  done: "Done",
};

interface RunContextValue {
  run: RunState | null;
  queue: QueuedTask[];
  agentStatus: AgentStatus;
  reconnecting: boolean;
  sendMessage: (
    conversationId: string,
    text: string,
    attachments?: Attachment[],
  ) => void;
  startTask: (text: string, attachments?: Attachment[]) => string;
  createConversation: (title?: string) => string;
  stopRun: () => void;
  removeQueued: (id: string) => void;
  runQueuedNow: () => void;
  retryEvent: (
    conversationId: string,
    messageId: string,
    eventId: string,
  ) => void;
  approve: (
    id: string,
    edit?: { excludedIds?: string[]; text?: string },
  ) => string | null;
  deny: (id: string, reason: string) => void;
  retryConnection: () => void;
}

const RunContext = createContext<RunContextValue | null>(null);

export function RunProvider({ children }: { children: ReactNode }) {
  const {
    conversations,
    setConversations,
    approvals,
    setApprovals,
    setGoals,
    setLibrary,
    chatScenario,
    setChatScenario,
    announce,
  } = useApp();
  const [run, setRunState] = useState<RunState | null>(null);
  const [queue, setQueueState] = useState<QueuedTask[]>([]);
  const [reconnecting, setReconnecting] = useState(false);
  const runRef = useRef<RunState | null>(null);
  const queueRef = useRef<QueuedTask[]>([]);
  const timers = useRef<number[]>([]);
  const approvalsRef = useRef(approvals);
  approvalsRef.current = approvals;
  const convRef = useRef(conversations);
  convRef.current = conversations;
  const scenarioRef = useRef(chatScenario);
  scenarioRef.current = chatScenario;

  useEffect(
    () => () => timers.current.forEach((t) => window.clearTimeout(t)),
    [],
  );

  const setRun = (r: RunState | null) => {
    runRef.current = r;
    setRunState(r);
  };
  const setQueue = (q: QueuedTask[]) => {
    queueRef.current = q;
    setQueueState(q);
  };
  const schedule = (ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  const patchConv = (id: string, fn: (c: Conversation) => Conversation) =>
    setConversations((cs) => cs.map((c) => (c.id === id ? fn(c) : c)));
  const appendMsg = (id: string, msg: Message) =>
    patchConv(id, (c) => ({
      ...c,
      messages: [...c.messages, msg],
      updatedAt: nowIso(),
    }));
  const patchMsg = (
    convId: string,
    msgId: string,
    fn: (m: Message) => Message,
  ) =>
    patchConv(convId, (c) => ({
      ...c,
      messages: c.messages.map((m) => (m.id === msgId ? fn(m) : m)),
      updatedAt: nowIso(),
    }));
  const addEvent = (convId: string, msgId: string, e: AgentEvent) =>
    patchMsg(convId, msgId, (m) => ({
      ...m,
      events: [...(m.events ?? []), e],
    }));
  const patchEvent = (
    convId: string,
    msgId: string,
    eventId: string,
    patch: Partial<AgentEvent>,
  ) =>
    patchMsg(convId, msgId, (m) => ({
      ...m,
      events: (m.events ?? []).map((e) =>
        e.id === eventId ? { ...e, ...patch } : e,
      ),
    }));
  const setPlanStatus = (
    convId: string,
    statuses: Conversation["plan"][number]["status"][],
  ) =>
    patchConv(convId, (c) => ({
      ...c,
      plan: c.plan.map((p, i) => ({ ...p, status: statuses[i] ?? p.status })),
    }));

  const processQueueRef = useRef<() => void>(() => undefined);

  const begin = (convId: string, text: string) => {
    const msgId = uid("m");
    const short = truncate(text, 60);
    const needsApproval = /\b(send|delete|trash)\b/i.test(text);
    const isSend = /\bsend\b/i.test(text);
    const isDelete = /\bdelete\b/i.test(text);
    const isMail = /mail|inbox|promo|newsletter/i.test(text);

    appendMsg(convId, {
      id: msgId,
      role: "agent",
      text: "",
      time: nowIso(),
      events: [],
      simulated: true,
      streaming: true,
    });
    patchConv(convId, (c) => ({
      ...c,
      plan: [
        { id: uid("p"), label: "Understand the request", status: "active" },
        { id: uid("p"), label: "Gather context", status: "todo" },
        { id: uid("p"), label: "Do the work", status: "todo" },
        {
          id: uid("p"),
          label: needsApproval ? "Ask before acting" : "Verify the result",
          status: "todo",
        },
      ],
    }));
    setRun({ conversationId: convId, messageId: msgId, phase: "planning" });
    const phase = (p: RunPhase) => {
      if (runRef.current?.messageId === msgId)
        setRun({ ...runRef.current, phase: p });
    };

    addEvent(convId, msgId, {
      id: "sim-plan",
      kind: "plan",
      title: "Planning the task",
      outcome: "Thinking…",
      status: "running",
    });

    schedule(800, () => {
      patchEvent(convId, msgId, "sim-plan", {
        title: "Planned the task",
        outcome: "4 steps",
        status: "done",
        detail:
          "Understand → gather context → do the work → " +
          (needsApproval ? "ask before acting." : "verify."),
      });
      addEvent(convId, msgId, {
        id: "sim-search",
        kind: "search",
        title: "Searching your workspace",
        outcome: "Searching…",
        status: "running",
        command: `search  "${truncate(text, 36)}"`,
      });
      setPlanStatus(convId, ["done", "active"]);
      phase("searching");
    });

    schedule(1900, () => {
      patchEvent(convId, msgId, "sim-search", {
        title: "Searched your workspace",
        outcome: "5 relevant items · demo data",
        status: "done",
      });
      addEvent(convId, msgId, {
        id: "sim-tool",
        kind: "tool",
        title: "Working with tools",
        outcome: "Running…",
        status: "running",
        command: "workspace.write  draft.md",
      });
      setPlanStatus(convId, ["done", "done", "active"]);
      phase("writing");
    });

    schedule(3100, () => {
      patchEvent(convId, msgId, "sim-tool", {
        title: "Drafted the result",
        outcome: "1 file · 1.2 KB",
        status: "done",
        output: "✓ wrote draft.md (simulated — nothing left this browser)",
      });
      if (needsApproval) {
        const approvalId = uid("a");
        const approval: Approval = isSend
          ? {
              id: approvalId,
              title: `Send: ${truncate(text, 48)}`,
              app: "Gmail",
              account: "maya@northwind.example",
              tool: "gmail.messages.send",
              params: JSON.stringify(
                {
                  request: short,
                  to: ["priya@northwind.example", "jonas@northwind.example"],
                },
                null,
                2,
              ),
              reversible: false,
              reversibleNote: "Irreversible — a sent email can’t be unsent.",
              rationale: `You asked: “${short}”. Sending reaches people outside this chat, so Blip needs your OK first.`,
              risk: "medium",
              affectedLabel: "2 recipients (demo)",
              affected: [
                {
                  id: "r1",
                  primary: "Priya Raman",
                  secondary: "priya@northwind.example",
                  meta: "To",
                },
                {
                  id: "r2",
                  primary: "Jonas Weber",
                  secondary: "jonas@northwind.example",
                  meta: "To",
                },
              ],
              changes: [
                { label: "Sent folder", before: "—", after: "+1 message" },
              ],
              editable: {
                kind: "text",
                label: "Message",
                value: `Hi Priya and Jonas,\n\nFollowing up on: ${short}\n\nThanks,\nMaya`,
              },
              conversationId: convId,
              status: "pending",
              requestedAt: nowIso(),
              fromChat: true,
            }
          : isMail
            ? {
                id: approvalId,
                title: "Move 12 promotional threads to Trash",
                app: "Gmail",
                account: "maya@northwind.example",
                tool: "gmail.threads.trash",
                params: JSON.stringify(
                  {
                    query: "category:promotions newer_than:30d -is:starred",
                    threads: 12,
                  },
                  null,
                  2,
                ),
                reversible: true,
                reversibleNote:
                  "Reversible for 30 days — threads can be restored from Trash.",
                rationale: `You asked: “${short}”. Trashing changes your mailbox, so Blip asks before acting.`,
                risk: "low",
                affectedLabel: "12 promotional threads (demo)",
                affected: promoThreads.slice(0, 12),
                excludedNote:
                  "Starred mail and contacts are excluded. No personal email is included.",
                changes: [
                  { label: "Inbox", before: "87 threads", after: "75 threads" },
                ],
                editable: { kind: "items" },
                conversationId: convId,
                status: "pending",
                requestedAt: nowIso(),
                fromChat: true,
              }
            : {
                id: approvalId,
                title: `${isDelete ? "Delete" : "Move to Trash"}: 3 workspace files`,
                app: "Workspace",
                account: "Local workspace (demo)",
                tool: isDelete
                  ? "workspace.files.delete"
                  : "workspace.files.trash",
                params: JSON.stringify({ request: short, files: 3 }, null, 2),
                reversible: !isDelete,
                reversibleNote: isDelete
                  ? "Irreversible — deleted files skip the snapshot bin."
                  : "Reversible — files stay in the snapshot bin for 14 days.",
                rationale: `You asked: “${short}”. Removing files changes your workspace, so Blip asks first.`,
                risk: isDelete ? "high" : "low",
                affectedLabel: "3 files",
                affected: [
                  {
                    id: "w1",
                    primary: "draft-old.md",
                    secondary: "Not opened in 41 days",
                    meta: "4.2 KB",
                  },
                  {
                    id: "w2",
                    primary: "notes-backup (2).txt",
                    secondary: "Duplicate of notes-backup.txt",
                    meta: "1.1 KB",
                  },
                  {
                    id: "w3",
                    primary: "untitled-3.md",
                    secondary: "Empty file",
                    meta: "0 B",
                  },
                ],
                changes: [
                  { label: "Workspace", before: "26 files", after: "23 files" },
                ],
                editable: { kind: "items" },
                conversationId: convId,
                status: "pending",
                requestedAt: nowIso(),
                fromChat: true,
              };
        setApprovals((list) => [approval, ...list]);
        addEvent(convId, msgId, {
          id: "sim-approval",
          kind: "approval",
          title: "Asked before acting",
          outcome: "Waiting on you",
          status: "waiting",
        });
        patchMsg(convId, msgId, (m) => ({
          ...m,
          streaming: false,
          approvalId,
          text: `I’ve prepared the action but **won’t do it without your OK**.\n\n- Exact action: \`${approval.tool}\`\n- ${approval.reversibleNote}\n\nReview the preview in Approvals — you can edit it, approve once, or deny.`,
        }));
        setPlanStatus(convId, ["done", "done", "done", "waiting"]);
        phase("approval");
        announce("Blip needs your approval before acting.");
        toast("Approval needed", { description: approval.title });
        schedule(400, () => {
          setRun(null);
          processQueueRef.current();
        });
      } else {
        addEvent(convId, msgId, {
          id: "sim-verify",
          kind: "verify",
          title: "Checking the result",
          outcome: "Verifying…",
          status: "running",
        });
        setPlanStatus(convId, ["done", "done", "done", "active"]);
        phase("verifying");
      }
    });

    if (!needsApproval) {
      schedule(4100, () => {
        patchEvent(convId, msgId, "sim-verify", {
          title: "Checked the result",
          outcome: "Matches your request",
          status: "done",
        });
        const content = `# ${short}\n\n*Simulated result — produced by the BLIP interactive demo. No external services were called.*\n\n## Summary\n- Understood the request and planned 4 steps.\n- Searched demo workspace data (5 items).\n- Drafted this document.\n\n## Next steps\n1. Review the draft.\n2. Ask Blip for changes in the chat.`;
        const item: LibraryItem = {
          id: uid("f"),
          name: `${slugify(short)}-summary.md`,
          kind: "document",
          origin: "blip",
          originTask: short,
          conversationId: convId,
          version: 1,
          size: content.length,
          mime: "text/markdown",
          status: "draft",
          updatedAt: nowIso(),
          content,
        };
        setLibrary((l) => [item, ...l]);
        patchConv(convId, (c) => ({ ...c, files: [item.id, ...c.files] }));
        patchMsg(convId, msgId, (m) => ({
          ...m,
          streaming: false,
          artifactId: item.id,
          text: `Here’s a **simulated** result for “${short}”.\n\n- Planned 4 steps and searched demo workspace data.\n- Drafted a summary and saved it to your Library.\n- Nothing was sent, changed or fetched outside this browser.\n\nOpen the draft below, or ask a follow-up.`,
        }));
        setPlanStatus(convId, ["done", "done", "done", "done"]);
        phase("done");
        announce("Run complete. A simulated draft was saved to your Library.");
        toast.success("Run complete", {
          description: "Simulated draft saved to Library",
        });
      });
      schedule(5600, () => {
        setRun(null);
        processQueueRef.current();
      });
    }
  };

  const processQueue = () => {
    if (runRef.current) return;
    const next = queueRef.current[0];
    if (!next) return;
    setQueue(queueRef.current.slice(1));
    patchMsg(next.conversationId, next.id, (m) => ({ ...m, queued: false }));
    begin(next.conversationId, next.text);
  };
  processQueueRef.current = processQueue;

  const sendMessage = (
    conversationId: string,
    text: string,
    attachments?: Attachment[],
  ) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const busy = Boolean(runRef.current) || scenarioRef.current === "offline";
    const msg: Message = {
      id: uid("m"),
      role: "user",
      text: trimmed,
      time: nowIso(),
      attachments: attachments?.length ? attachments : undefined,
      queued: busy || undefined,
    };
    patchConv(conversationId, (c) => ({
      ...c,
      title:
        c.title === "New chat" && c.messages.length === 0
          ? truncate(trimmed, 42)
          : c.title,
      messages: [...c.messages, msg],
      updatedAt: nowIso(),
    }));
    if (busy) {
      setQueue([
        ...queueRef.current,
        { id: msg.id, conversationId, text: trimmed },
      ]);
      toast(
        scenarioRef.current === "offline"
          ? "Queued until you’re back online"
          : "Queued as a follow-up",
        {
          description: "It will run after the current task.",
        },
      );
      return;
    }
    begin(conversationId, trimmed);
  };

  const createConversation = (title?: string) => {
    const id = uid("c");
    const conv: Conversation = {
      id,
      title: title ?? "New chat",
      pinned: false,
      updatedAt: nowIso(),
      files: [],
      plan: [],
      messages: [],
    };
    setConversations((cs) => [conv, ...cs]);
    return id;
  };

  const startTask = (text: string, attachments?: Attachment[]) => {
    const id = createConversation(truncate(text, 42));
    sendMessage(id, text, attachments);
    return id;
  };

  const stopRun = () => {
    const r = runRef.current;
    if (!r) return;
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    patchMsg(r.conversationId, r.messageId, (m) => ({
      ...m,
      streaming: false,
      text: m.text || "Stopped at your request. Nothing else was changed.",
      events: (m.events ?? []).map((e) =>
        e.status === "running"
          ? { ...e, status: "attention", outcome: "Stopped by you" }
          : e,
      ),
    }));
    patchConv(r.conversationId, (c) => ({
      ...c,
      plan: c.plan.map((p) =>
        p.status === "active" ? { ...p, status: "todo" } : p,
      ),
    }));
    setRun(null);
    announce("Run stopped.");
  };

  const removeQueued = (id: string) => {
    const item = queueRef.current.find((q) => q.id === id);
    setQueue(queueRef.current.filter((q) => q.id !== id));
    if (item)
      patchConv(item.conversationId, (c) => ({
        ...c,
        messages: c.messages.filter((m) => m.id !== id),
      }));
  };

  const retryEvent = (
    conversationId: string,
    messageId: string,
    eventId: string,
  ) => {
    const conv = convRef.current.find((c) => c.id === conversationId);
    const original = conv?.messages
      .find((m) => m.id === messageId)
      ?.events?.find((e) => e.id === eventId);
    patchEvent(conversationId, messageId, eventId, {
      status: "running",
      outcome: "Retrying…",
    });
    announce("Retrying the build.");
    schedule(1600, () => {
      patchEvent(conversationId, messageId, eventId, {
        status: "done",
        outcome: "Passed · built in 2.1 s",
        retryable: false,
        output: `${original?.output ?? ""}\n\n— Retry (simulated, after applying the “Untitled” fix) —\n> tsc && vite build\n✓ 14 modules transformed.\n✓ built in 2.1s`,
      });
      patchConv(conversationId, (c) => ({
        ...c,
        plan: c.plan.map((p) =>
          p.status === "blocked" ? { ...p, status: "done" } : p,
        ),
      }));
      announce("Build retry succeeded (simulated).");
      toast.success("Build passed", {
        description: "Simulated retry — no real build ran.",
      });
    });
  };

  const markApprovalEvent = (
    approvalId: string,
    convId: string,
    status: AgentEvent["status"],
    outcome: string,
  ) =>
    patchConv(convId, (c) => ({
      ...c,
      messages: c.messages.map((m) =>
        m.approvalId === approvalId
          ? {
              ...m,
              events: m.events?.map((e) =>
                e.kind === "approval" && e.status === "waiting"
                  ? { ...e, status, outcome }
                  : e,
              ),
            }
          : m,
      ),
    }));

  const approve = (
    id: string,
    edit?: { excludedIds?: string[]; text?: string },
  ) => {
    const appr = approvalsRef.current.find((a) => a.id === id);
    if (!appr || appr.status !== "pending") return null;
    const receipt = receiptCode();
    const count =
      appr.editable?.kind === "items"
        ? appr.affected.length - (edit?.excludedIds?.length ?? 0)
        : appr.affected.length;
    setApprovals((list) =>
      list.map((a) =>
        a.id === id
          ? {
              ...a,
              status: "approved",
              resolvedAt: nowIso(),
              receiptId: receipt,
              excludedIds: edit?.excludedIds,
              editedText: edit?.text,
            }
          : a,
      ),
    );
    const convId = appr.conversationId;
    if (convId && convRef.current.some((c) => c.id === convId)) {
      markApprovalEvent(id, convId, "done", "Approved once");
      patchConv(convId, (c) => ({
        ...c,
        plan: c.plan.map((p) =>
          p.status === "waiting" ? { ...p, status: "done" } : p,
        ),
      }));
      appendMsg(convId, {
        id: uid("m"),
        role: "agent",
        time: nowIso(),
        simulated: true,
        text: `Approved — **${appr.title}**.\n\nDemo receipt \`${receipt}\`: the real product would call \`${appr.tool}\` on ${count} item${count === 1 ? "" : "s"}. In this demo, nothing left your browser.`,
      });
    }
    if (appr.goalId) {
      setGoals((gs) =>
        gs.map((g) =>
          g.id === appr.goalId
            ? {
                ...g,
                status: "complete",
                progress: 100,
                currentStep: "Complete",
                blocker: undefined,
                criteria: g.criteria.map((k) => ({
                  ...k,
                  state: "met",
                  evidence:
                    k.state === "met"
                      ? k.evidence
                      : `Approved · ${receipt} (simulated)`,
                })),
                plan: g.plan.map((p) => ({ ...p, status: "done" })),
                activity: [
                  {
                    id: uid("ga"),
                    time: nowIso(),
                    text: `Approved ${count} items · receipt ${receipt} (simulated)`,
                    tone: "healthy",
                  },
                  ...g.activity,
                ],
                updatedAt: nowIso(),
              }
            : g,
        ),
      );
    }
    announce(`Approved once. Demo receipt ${receipt}.`);
    return receipt;
  };

  const deny = (id: string, reason: string) => {
    const appr = approvalsRef.current.find((a) => a.id === id);
    if (!appr || appr.status !== "pending") return;
    setApprovals((list) =>
      list.map((a) =>
        a.id === id
          ? { ...a, status: "denied", resolvedAt: nowIso(), denyReason: reason }
          : a,
      ),
    );
    const convId = appr.conversationId;
    if (convId && convRef.current.some((c) => c.id === convId)) {
      markApprovalEvent(id, convId, "attention", "Denied by you");
      appendMsg(convId, {
        id: uid("m"),
        role: "system",
        time: nowIso(),
        text: `You denied “${appr.title}”. Reason: ${reason}. Nothing was changed.`,
      });
    }
    if (appr.goalId) {
      setGoals((gs) =>
        gs.map((g) =>
          g.id === appr.goalId
            ? {
                ...g,
                status: "paused",
                blocker: `You denied the action — ${reason}. Add an instruction or resume when ready.`,
                activity: [
                  {
                    id: uid("ga"),
                    time: nowIso(),
                    text: `Approval denied: ${reason}`,
                    tone: "attention",
                  },
                  ...g.activity,
                ],
                updatedAt: nowIso(),
              }
            : g,
        ),
      );
    }
    announce("Denied. Nothing was changed.");
  };

  const retryConnection = () => {
    setReconnecting(true);
    schedule(1200, () => {
      setReconnecting(false);
      setChatScenario("ready");
      scenarioRef.current = "ready";
      announce("Connection restored (simulated).");
      toast.success("Back online", { description: "Simulated reconnection." });
      processQueueRef.current();
    });
  };

  const pending = approvals.filter((a) => a.status === "pending").length;
  const agentStatus: AgentStatus =
    chatScenario === "offline"
      ? "offline"
      : run && run.phase !== "done" && run.phase !== "approval"
        ? "running"
        : pending > 0
          ? "waiting"
          : "ready";

  const value: RunContextValue = {
    run,
    queue,
    agentStatus,
    reconnecting,
    sendMessage,
    startTask,
    createConversation,
    stopRun,
    removeQueued,
    runQueuedNow: processQueue,
    retryEvent,
    approve,
    deny,
    retryConnection,
  };

  return <RunContext.Provider value={value}>{children}</RunContext.Provider>;
}

export function useRun(): RunContextValue {
  const ctx = useContext(RunContext);
  if (!ctx) throw new Error("useRun must be used inside RunProvider");
  return ctx;
}
