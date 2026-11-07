import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, PanelRight, Target, Trash2 } from "lucide-react";
import type {
  ChatScenario,
  Conversation,
  MascotStateId,
  Message,
} from "../../types";
import { useApp } from "../../contexts/AppContext";
import { PHASE_LABEL, PHASE_MASCOT, useRun } from "../../contexts/RunContext";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { Mascot } from "../mascot/Mascot";
import { Button } from "../ui/Button";
import { Segmented } from "../ui/Segmented";
import { Dialog } from "../ui/Dialog";
import { MessageItem } from "./MessageItem";
import { Composer } from "./Composer";
import { ContextRail } from "./ContextRail";
import { ChatEmptyState } from "./ChatEmptyState";
import { ScenarioBanner } from "./ScenarioBanner";
import { mascotLabel } from "../../data/mascotStates";
import { nowIso } from "../../utils/time";

interface ThreadViewProps {
  conversation: Conversation;
  onBack: () => void;
  onDelete: () => void;
}

const SCENARIOS: { value: ChatScenario; label: string }[] = [
  { value: "ready", label: "Ready" },
  { value: "running", label: "Running" },
  { value: "approval", label: "Approval" },
  { value: "error", label: "Error" },
  { value: "offline", label: "Offline" },
  { value: "empty", label: "Empty" },
];

const DEMO_RUNNING: Message = {
  id: "demo-running",
  role: "agent",
  text: "",
  time: nowIso(),
  simulated: true,
  streaming: true,
  events: [
    {
      id: "d1",
      kind: "plan",
      title: "Planned the task",
      outcome: "3 steps",
      status: "done",
    },
    {
      id: "d2",
      kind: "search",
      title: "Searching sources",
      outcome: "Reading 4 of 9…",
      status: "running",
    },
  ],
};

export function ThreadView({
  conversation,
  onBack,
  onDelete,
}: ThreadViewProps) {
  const {
    approvals,
    library,
    goals,
    navigate,
    chatScenario,
    setChatScenario,
    announce,
  } = useApp();
  const {
    run,
    queue,
    sendMessage,
    stopRun,
    removeQueued,
    runQueuedNow,
    retryEvent,
  } = useRun();
  const xl = useMediaQuery("(min-width: 1280px)");
  const [railVisible, setRailVisible] = useState(true);
  const [railSheet, setRailSheet] = useState(false);
  const [focused, setFocused] = useState(false);
  const [prefill, setPrefill] = useState<{ text: string; key: number }>();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const live = run?.conversationId === conversation.id;
  const demoRunning = chatScenario === "running" && !live;
  const pendingHere = approvals.some(
    (a) => a.status === "pending" && a.conversationId === conversation.id,
  );
  const showEmpty =
    chatScenario === "empty" || conversation.messages.length === 0;
  const goal = conversation.goalId
    ? goals.find((g) => g.id === conversation.goalId)
    : undefined;
  const convQueue = queue.filter((q) => q.conversationId === conversation.id);

  const mascotState: MascotStateId =
    chatScenario === "offline"
      ? "offline"
      : chatScenario === "error"
        ? "oops"
        : live && run
          ? PHASE_MASCOT[run.phase]
          : demoRunning
            ? "running"
            : chatScenario === "approval" || pendingHere
              ? "approval"
              : focused
                ? "listening"
                : "idle";

  const statusText =
    live && run
      ? PHASE_LABEL[run.phase]
      : demoRunning
        ? "Running (demo state)"
        : chatScenario === "offline"
          ? "Offline · simulated"
          : chatScenario === "error"
            ? "Hit an error"
            : pendingHere
              ? "Waiting for your approval"
              : focused
                ? "Listening"
                : "Ready";

  const messages = useMemo(
    () =>
      demoRunning
        ? [...conversation.messages, DEMO_RUNNING]
        : conversation.messages,
    [conversation.messages, demoRunning],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, chatScenario]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (
        e.key === "/" &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) &&
        !t.isContentEditable
      ) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const send = (
    text: string,
    attachments: Parameters<typeof sendMessage>[2],
  ) => {
    if (chatScenario === "empty") setChatScenario("ready");
    sendMessage(conversation.id, text, attachments);
  };

  const rail = <ContextRail conversation={conversation} />;

  return (
    <div className="flex h-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2 md:px-5">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Back to conversations"
            onClick={onBack}
          >
            <ArrowLeft />
          </Button>
          <Mascot
            state={mascotState}
            size={44}
            label={`Blip — ${mascotLabel(mascotState)}`}
          />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em]">
              {conversation.title}
            </h2>
            <p className="truncate text-[12.5px] text-ink-3" aria-live="polite">
              {statusText}
            </p>
          </div>
          {goal && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Target />}
              className="hidden sm:inline-flex"
              onClick={() => navigate("goals", goal.id)}
            >
              Goal
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Delete conversation"
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={
              xl
                ? railVisible
                  ? "Hide context panel"
                  : "Show context panel"
                : "Open files and run plan"
            }
            aria-pressed={xl ? railVisible : undefined}
            onClick={() =>
              xl ? setRailVisible((v) => !v) : setRailSheet(true)
            }
          >
            <PanelRight />
          </Button>
        </div>

        <div className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-2 md:px-5">
          <span className="shrink-0 font-mono text-[10.5px] tracking-[0.06em] text-ink-3">
            Demo state
          </span>
          <Segmented
            ariaLabel="Demo state"
            size="sm"
            scroll
            value={chatScenario}
            onChange={(v) => {
              setChatScenario(v);
              announce(`Demo state: ${v}`);
            }}
            options={SCENARIOS}
          />
        </div>

        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto scroll-thin"
          style={{ scrollBehavior: "auto" }}
        >
          {showEmpty ? (
            <ChatEmptyState
              mascotState={focused ? "listening" : "idle"}
              onPick={(p) => send(p, [])}
            />
          ) : (
            <div className="mx-auto w-full max-w-[780px] space-y-7 px-4 py-6 md:px-6 md:py-8">
              {messages.map((m) => (
                <MessageItem
                  key={m.id}
                  message={m}
                  live={
                    (live && run?.messageId === m.id) || m.id === "demo-running"
                  }
                  approval={
                    m.approvalId
                      ? approvals.find((a) => a.id === m.approvalId)
                      : undefined
                  }
                  artifact={
                    m.artifactId
                      ? library.find((f) => f.id === m.artifactId)
                      : undefined
                  }
                  onRetryEvent={(eventId) =>
                    retryEvent(conversation.id, m.id, eventId)
                  }
                  onOpenArtifact={(id) => navigate("library", id)}
                  onOpenApproval={(id) => navigate("approvals", id)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-line bg-canvas px-3 pb-3 pt-3 md:px-5 md:pb-4">
          <div className="mx-auto w-full max-w-[780px] space-y-3">
            <ScenarioBanner scenario={chatScenario} />
            <Composer
              inputRef={inputRef}
              prefill={prefill}
              running={live || demoRunning}
              offline={chatScenario === "offline"}
              queued={convQueue}
              onRemoveQueued={removeQueued}
              onRunQueued={runQueuedNow}
              onFocusChange={setFocused}
              onSend={send}
              onStop={() => {
                if (live) stopRun();
                else {
                  setChatScenario("ready");
                  announce("Demo run stopped.");
                }
              }}
            />
            {chatScenario === "error" && (
              <button
                type="button"
                className="text-[12.5px] text-ink-3 underline underline-offset-4"
                onClick={() =>
                  setPrefill({
                    text:
                      conversation.messages
                        .filter((m) => m.role === "user")
                        .slice(-1)[0]?.text ?? "",
                    key: Date.now(),
                  })
                }
              >
                Put my last message back in the composer
              </button>
            )}
          </div>
        </div>
      </div>

      {xl && railVisible && (
        <aside
          aria-label="Conversation context"
          className="w-[300px] shrink-0 overflow-y-auto border-l border-line bg-canvas px-5 py-5 scroll-thin"
        >
          {rail}
        </aside>
      )}
      {!xl && (
        <Dialog
          open={railSheet}
          onClose={() => setRailSheet(false)}
          variant="side"
          title="Context"
          description={conversation.title}
        >
          {rail}
        </Dialog>
      )}
    </div>
  );
}
