import React from "react";
import { useApp } from "../../contexts/AppContext";
import { weekStats } from "../../data/overview";

export function StatsBand() {
  const { goals, conversations } = useApp();
  const inMotion = goals.filter(
    (g) => g.status !== "complete" && g.status !== "cancelled",
  ).length;
  const simulatedDone = conversations
    .flatMap((c) => c.messages)
    .filter((m) => m.simulated && m.artifactId).length;
  const stats = [
    {
      value: String(inMotion),
      label: "goals in motion",
      note: "across chats and routines",
    },
    {
      value: String(weekStats.tasksCompleted + simulatedDone),
      label: "tasks completed",
      note: "this week",
    },
    {
      value: `${weekStats.hoursSaved} h`,
      label: "time saved",
      note: "demo estimate",
    },
  ];
  return (
    <section
      aria-label="This week"
      className="grid grid-cols-1 divide-y divide-line border-y border-line sm:grid-cols-3 sm:divide-x sm:divide-y-0"
    >
      {stats.map((s) => (
        <div key={s.label} className="px-1 py-6 sm:px-8 sm:first:pl-0">
          <p className="tabular text-[40px] font-semibold leading-none tracking-[-0.04em] md:text-[48px]">
            {s.value}
          </p>
          <p className="mt-2 text-[14px] font-medium">{s.label}</p>
          <p className="font-mono text-[11px] text-ink-3">{s.note}</p>
        </div>
      ))}
    </section>
  );
}
