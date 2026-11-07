import React from "react";
import { useApp } from "../../contexts/AppContext";
import { PHASE_LABEL, useRun } from "../../contexts/RunContext";

const MAP = {
  ready: {
    dot: "bg-sage",
    label: "Ready",
    hint: "Blip is idle and ready for a task.",
  },
  running: {
    dot: "bg-accent",
    label: "Working",
    hint: "A simulated run is in progress.",
  },
  waiting: {
    dot: "bg-amber",
    label: "Needs you",
    hint: "Actions are waiting for your approval.",
  },
  offline: {
    dot: "bg-ink-3",
    label: "Offline",
    hint: "Simulated offline state.",
  },
} as const;

/** Global agent status. Reflects only the agent — a single app connection issue never changes it. */
export function AgentStatusChip({ className = "" }: { className?: string }) {
  const { navigate, approvals } = useApp();
  const { agentStatus, run } = useRun();
  const s = MAP[agentStatus];
  const pending = approvals.filter((a) => a.status === "pending").length;
  const label =
    agentStatus === "running" && run
      ? PHASE_LABEL[run.phase]
      : agentStatus === "waiting"
        ? `Needs you · ${pending}`
        : s.label;

  const onClick = () => {
    if (agentStatus === "waiting") navigate("approvals");
    else if (agentStatus === "running" && run)
      navigate("chat", run.conversationId);
    else if (agentStatus === "offline") navigate("chat");
    else navigate("overview");
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={s.hint}
      aria-label={`Agent status: ${label}. ${s.hint}`}
      className={`inline-flex h-9 items-center gap-2 rounded-full border border-line bg-surface px-3 text-[13px] font-medium text-ink transition-[border-color] duration-150 hover:border-line-strong ${className}`}
    >
      <span className="relative flex h-2 w-2" aria-hidden>
        {agentStatus === "running" && (
          <span
            className={`absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping ${s.dot}`}
          />
        )}
        <span className={`relative h-2 w-2 rounded-full ${s.dot}`} />
      </span>
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
}
