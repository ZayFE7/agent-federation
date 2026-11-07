import React, { useState } from "react";
import {
  ArrowRight,
  Circle,
  CircleCheck,
  CircleDot,
  Clock,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  AppWindow,
  Captions,
  Paperclip,
  TriangleAlert,
} from "lucide-react";
import type { Conversation, LibraryKind, PlanStatus } from "../../types";
import { useApp } from "../../contexts/AppContext";
import { Segmented } from "../ui/Segmented";
import { ProgressBar } from "../ui/ProgressBar";
import { GoalStatusBadge } from "../goals/GoalStatusBadge";
import { formatBytes } from "../../utils/format";

export const KIND_ICON: Record<LibraryKind, typeof FileText> = {
  document: FileText,
  code: FileCode,
  app: AppWindow,
  audio: FileAudio,
  image: FileImage,
  subtitle: Captions,
  other: FileText,
};

const PLAN_ICON: Record<
  PlanStatus,
  { Icon: typeof Circle; cls: string; label: string }
> = {
  done: { Icon: CircleCheck, cls: "text-sage", label: "Done" },
  active: { Icon: CircleDot, cls: "text-accent", label: "In progress" },
  todo: { Icon: Circle, cls: "text-ink-3", label: "Not started" },
  waiting: { Icon: Clock, cls: "text-amber", label: "Waiting on you" },
  blocked: { Icon: TriangleAlert, cls: "text-amber", label: "Blocked" },
};

export function PlanList({ steps }: { steps: Conversation["plan"] }) {
  return (
    <ol className="relative">
      {steps.map((s, i) => {
        const { Icon, cls, label } = PLAN_ICON[s.status];
        return (
          <li key={s.id} className="relative flex gap-3 pb-4 last:pb-0">
            {i < steps.length - 1 && (
              <span
                className="absolute left-[9px] top-6 bottom-0 w-px bg-line"
                aria-hidden
              />
            )}
            <Icon
              className={`relative mt-0.5 h-[19px] w-[19px] shrink-0 bg-surface ${cls}`}
              aria-hidden
            />
            <div className="min-w-0">
              <p
                className={`text-[13.5px] leading-snug ${s.status === "todo" ? "text-ink-2" : "text-ink"}`}
              >
                {s.label}
              </p>
              <p className="text-[12px] text-ink-3">{label}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function ContextRail({ conversation }: { conversation: Conversation }) {
  const { library, goals, navigate } = useApp();
  const [tab, setTab] = useState<"files" | "plan">("files");
  const files = conversation.files
    .map((id) => library.find((f) => f.id === id))
    .filter((f): f is NonNullable<typeof f> => Boolean(f));
  const attachments = conversation.messages.flatMap((m) => m.attachments ?? []);
  const goal = conversation.goalId
    ? goals.find((g) => g.id === conversation.goalId)
    : undefined;

  return (
    <div className="space-y-5">
      <Segmented
        ariaLabel="Context"
        value={tab}
        onChange={setTab}
        className="w-full [&>button]:flex-1"
        options={[
          {
            value: "files",
            label: "Files",
            count: files.length + attachments.length,
          },
          { value: "plan", label: "Run plan", count: conversation.plan.length },
        ]}
      />
      {tab === "files" ? (
        <div className="space-y-5">
          {files.length === 0 && attachments.length === 0 && (
            <p className="rounded-2xl border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-ink-3">
              No files yet. Anything Blip creates here lands in your Library.
            </p>
          )}
          {files.length > 0 && (
            <ul className="space-y-1">
              {files.map((f) => {
                const Icon = KIND_ICON[f.kind];
                return (
                  <li key={f.id}>
                    <button
                      type="button"
                      onClick={() => navigate("library", f.id)}
                      className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors duration-150 hover:bg-ink/[0.04]"
                    >
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ink/[0.05] text-ink-2">
                        <Icon className="h-4 w-4" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-medium">
                          {f.name}
                        </span>
                        <span className="block text-[12px] text-ink-3">
                          v{f.version} ·{" "}
                          {f.kind === "audio"
                            ? "transcript"
                            : formatBytes(f.size)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {attachments.length > 0 && (
            <div>
              <p className="mb-2 font-mono text-[10.5px] tracking-[0.06em] text-ink-3">
                Attached in chat · local only
              </p>
              <ul className="space-y-1.5">
                {attachments.map((a, i) => (
                  <li
                    key={`${a.name}-${i}`}
                    className="flex items-center gap-2 px-2 text-[13px]"
                  >
                    <Paperclip className="h-3.5 w-3.5 text-ink-3" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{a.name}</span>
                    <span className="text-[12px] text-ink-3">
                      {formatBytes(a.size)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          {conversation.plan.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-ink-3">
              Blip shows its plan here as soon as a task starts.
            </p>
          ) : (
            <PlanList steps={conversation.plan} />
          )}
        </div>
      )}
      {goal && (
        <div className="rounded-2xl border border-line bg-surface p-4">
          <div className="flex items-start justify-between gap-2">
            <p className="font-mono text-[10.5px] tracking-[0.06em] text-ink-3">
              Linked goal
            </p>
            <GoalStatusBadge status={goal.status} />
          </div>
          <p className="mt-2 text-[14px] font-medium leading-snug">
            {goal.title}
          </p>
          <ProgressBar
            value={goal.progress}
            label={`${goal.title} progress`}
            className="mt-3"
          />
          <button
            type="button"
            onClick={() => navigate("goals", goal.id)}
            className="mt-3 inline-flex min-h-[36px] items-center gap-1 text-[13px] font-medium text-ink-2 hover:text-ink"
          >
            Open goal <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}
