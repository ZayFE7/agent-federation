import React, { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  BookOpen,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Hand,
  ListChecks,
  LoaderCircle,
  PenLine,
  RotateCcw,
  Search,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import type { AgentEvent, EventKind, EventStatus } from "../../types";
import { Button } from "../ui/Button";

const KIND_ICON: Record<EventKind, typeof Search> = {
  plan: ListChecks,
  search: Search,
  read: BookOpen,
  tool: Terminal,
  write: PenLine,
  verify: ShieldCheck,
  approval: Hand,
};

const STATUS_STYLE: Record<
  EventStatus,
  { cls: string; Icon: typeof CircleCheck }
> = {
  done: { cls: "text-sage-ink", Icon: CircleCheck },
  running: { cls: "text-accent-ink", Icon: LoaderCircle },
  failed: { cls: "text-rose-ink", Icon: CircleX },
  waiting: { cls: "text-amber-ink", Icon: Clock },
  attention: { cls: "text-amber-ink", Icon: CircleAlert },
};

interface EventTimelineProps {
  events: AgentEvent[];
  live?: boolean;
  onRetry?: (eventId: string) => void;
}

export function EventTimeline({ events, live, onRetry }: EventTimelineProps) {
  const needsEye = events.some(
    (e) => e.status === "failed" || e.status === "attention",
  );
  const [open, setOpen] = useState(Boolean(live) || needsEye);
  useEffect(() => {
    if (live) setOpen(true);
  }, [live]);

  if (events.length === 0) return null;
  const running = events.find((e) => e.status === "running");
  const failed = events.filter((e) => e.status === "failed").length;
  const attention = events.filter(
    (e) => e.status === "attention" || e.status === "waiting",
  ).length;
  const done = events.filter((e) => e.status === "done").length;

  const summary = running
    ? `Working · ${running.title}`
    : `${events.length} steps`;

  return (
    <div className="rounded-2xl border border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-[44px] w-full items-center gap-3 px-4 py-2.5 text-left"
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
          <span className="font-medium text-ink">{summary}</span>
          {!running && (
            <span className="flex flex-wrap items-center gap-x-3 text-ink-3">
              <span className="text-sage-ink">{done} done</span>
              {attention > 0 && (
                <span className="text-amber-ink">
                  {attention} need{attention === 1 ? "s" : ""} you
                </span>
              )}
              {failed > 0 && (
                <span className="text-rose-ink">{failed} failed</span>
              )}
            </span>
          )}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-ink-3 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <ol className="border-t border-line px-4 py-3">
              <AnimatePresence initial={false}>
                {events.map((e, i) => (
                  <EventRow
                    key={e.id}
                    event={e}
                    last={i === events.length - 1}
                    onRetry={onRetry}
                  />
                ))}
              </AnimatePresence>
            </ol>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function EventRow({
  event,
  last,
  onRetry,
}: {
  event: AgentEvent;
  last: boolean;
  onRetry?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(event.status === "failed");
  const KindIcon = KIND_ICON[event.kind];
  const { cls, Icon } = STATUS_STYLE[event.status];
  const hasDetails = Boolean(event.detail || event.command || event.output);

  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
      className="relative flex gap-3 pb-3 last:pb-0"
    >
      {!last && (
        <span
          className="absolute left-[13px] top-8 bottom-0 w-px bg-line"
          aria-hidden
        />
      )}
      <span className="relative mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-ink/[0.05] text-ink-2">
        <KindIcon className="h-3.5 w-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pt-[3px]">
          <span className="text-[13.5px] font-medium text-ink">
            {event.title}
          </span>
          <span
            className={`inline-flex items-center gap-1 text-[12.5px] ${cls}`}
          >
            <Icon
              className={`h-3.5 w-3.5 ${event.status === "running" ? "animate-spin" : ""}`}
              aria-hidden
            />
            {event.outcome}
          </span>
          {hasDetails && (
            <button
              type="button"
              onClick={() => setExpanded((x) => !x)}
              aria-expanded={expanded}
              className="ml-auto min-h-[32px] rounded-md px-1.5 text-[12px] text-ink-3 transition-colors hover:text-ink"
            >
              {expanded ? "Hide details" : "Details"}
            </button>
          )}
        </div>
        {expanded && hasDetails && (
          <div className="mt-2 space-y-2">
            {event.detail && (
              <p className="text-[13px] leading-relaxed text-ink-2">
                {event.detail}
              </p>
            )}
            {event.command && (
              <p className="overflow-x-auto whitespace-nowrap rounded-lg bg-sunken px-3 py-2 font-mono text-[12px] text-ink scroll-thin">
                <span className="select-none text-ink-3">$ </span>
                {event.command}
              </p>
            )}
            {event.output && (
              <pre
                className={`max-h-64 overflow-auto rounded-lg border px-3 py-2.5 font-mono text-[11.5px] leading-relaxed scroll-thin ${event.status === "failed" ? "border-rose/25 bg-rose-soft/50 text-ink" : "border-line bg-sunken text-ink-2"}`}
              >
                {event.output}
              </pre>
            )}
            {event.status === "failed" && event.retryable && onRetry && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<RotateCcw />}
                  onClick={() => onRetry(event.id)}
                >
                  Retry {event.command ?? "step"}
                </Button>
                <span className="text-[12px] text-ink-3">
                  Runtime error — safe to retry. Simulated.
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </motion.li>
  );
}
