import React, { useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowRight,
  Copy,
  FileText,
  Hand,
  Paperclip,
  Receipt,
  Volume2,
  VolumeX,
} from "lucide-react";
import { toast } from "sonner";
import type { Approval, LibraryItem, Message } from "../../types";
import { MascotStill } from "../mascot/MascotStill";
import { EventTimeline } from "./EventTimeline";
import { RichText } from "./RichText";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Skeleton } from "../ui/EmptyState";
import { formatBytes } from "../../utils/format";
import { formatTime } from "../../utils/time";

interface MessageItemProps {
  message: Message;
  live?: boolean;
  approval?: Approval;
  artifact?: LibraryItem;
  onRetryEvent?: (eventId: string) => void;
  onOpenArtifact?: (id: string) => void;
  onOpenApproval?: (id: string) => void;
}

export function MessageItem({
  message,
  live,
  approval,
  artifact,
  onRetryEvent,
  onOpenArtifact,
  onOpenApproval,
}: MessageItemProps) {
  const [listening, setListening] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);

  if (message.role === "system") {
    return (
      <div
        className="flex items-center gap-3 py-1 text-[12.5px] text-ink-3"
        role="note"
      >
        <span className="h-px flex-1 bg-line" aria-hidden />
        <span className="max-w-[80%] text-center">{message.text}</span>
        <span className="h-px flex-1 bg-line" aria-hidden />
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
        className="flex flex-col items-end gap-1.5"
      >
        <div
          className={`max-w-[88%] rounded-[18px] rounded-br-md px-4 py-2.5 text-[15px] leading-relaxed sm:max-w-[78%] ${message.queued ? "border border-dashed border-line-strong bg-surface text-ink-2" : "bg-accent-soft text-ink"}`}
        >
          <p className="whitespace-pre-wrap">{message.text}</p>
          {message.attachments && (
            <ul
              className="mt-2 flex flex-wrap gap-1.5"
              aria-label="Attachments"
            >
              {message.attachments.map((a) => (
                <li
                  key={a.name}
                  className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-surface/70 px-2 text-[12px]"
                >
                  <Paperclip className="h-3 w-3" aria-hidden />
                  {a.name}{" "}
                  <span className="text-ink-3">{formatBytes(a.size)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <span className="flex items-center gap-2 text-[11.5px] text-ink-3">
          {message.queued && <Badge tone="neutral">Queued · runs next</Badge>}
          {formatTime(message.time)}
        </span>
      </motion.div>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.text);
      toast.success("Copied to clipboard");
    } catch {
      toast("Couldn’t access the clipboard", {
        description: "Select the text and copy it manually.",
      });
    }
  };

  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
      className="flex gap-3"
      aria-label="Blip’s reply"
    >
      <MascotStill
        state={message.streaming ? "thinking" : "idle"}
        size={32}
        className="mt-0.5 shrink-0"
      />
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
          <span className="font-medium text-ink">Blip</span>
          <span>{formatTime(message.time)}</span>
          {message.simulated && <Badge tone="accent">Simulated result</Badge>}
        </div>

        {message.events && message.events.length > 0 && (
          <EventTimeline
            events={message.events}
            live={live}
            onRetry={onRetryEvent}
          />
        )}

        {message.text ? (
          <RichText
            text={message.text}
            citations={message.citations}
            onCite={(n) => setHighlight(n)}
          />
        ) : message.streaming ? (
          <div className="space-y-2 pt-1" aria-label="Blip is working">
            <Skeleton className="h-3.5 w-[86%]" />
            <Skeleton className="h-3.5 w-[64%]" />
          </div>
        ) : null}

        {message.citations && message.citations.length > 0 && (
          <div>
            <p className="mb-1.5 font-mono text-[10.5px] tracking-[0.06em] text-ink-3">
              Sources
            </p>
            <ol className="space-y-1">
              {message.citations.map((c) => (
                <li
                  key={c.n}
                  className={`flex items-baseline gap-2 rounded-lg px-2 py-1 text-[13px] transition-colors duration-200 ${highlight === c.n ? "bg-accent-soft" : ""}`}
                >
                  <span className="font-mono text-[11px] text-accent-ink">
                    {c.n}
                  </span>
                  <span className="text-ink">{c.label}</span>
                  <span className="truncate text-ink-3">{c.source}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {artifact && (
          <button
            type="button"
            onClick={() => onOpenArtifact?.(artifact.id)}
            className="flex w-full max-w-md items-center gap-3 rounded-2xl border border-line bg-surface p-3 text-left shadow-soft transition-[transform,box-shadow] duration-150 ease-out hover:-translate-y-px hover:shadow-lift"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-ink">
              <FileText className="h-4 w-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium">
                {artifact.name}
              </span>
              <span className="block text-[12px] text-ink-3">
                v{artifact.version} ·{" "}
                {artifact.kind === "audio"
                  ? "transcript available"
                  : formatBytes(artifact.size)}{" "}
                · Library
              </span>
            </span>
            <ArrowRight className="h-4 w-4 text-ink-3" aria-hidden />
          </button>
        )}

        {approval && (
          <div
            className={`flex flex-col gap-3 rounded-2xl border px-4 py-3 sm:flex-row sm:items-center ${
              approval.status === "pending"
                ? "border-amber/30 bg-amber-soft"
                : approval.status === "approved"
                  ? "border-sage/25 bg-sage-soft"
                  : "border-line bg-ink/[0.03]"
            }`}
          >
            <span className="flex min-w-0 flex-1 items-start gap-2.5">
              {approval.status === "approved" ? (
                <Receipt
                  className="mt-0.5 h-4 w-4 shrink-0 text-sage-ink"
                  aria-hidden
                />
              ) : (
                <Hand
                  className="mt-0.5 h-4 w-4 shrink-0 text-amber-ink"
                  aria-hidden
                />
              )}
              <span className="min-w-0 text-[13.5px]">
                <span className="block font-medium text-ink">
                  {approval.status === "pending"
                    ? "Waiting for your approval"
                    : approval.status === "approved"
                      ? `Approved once · ${approval.receiptId}`
                      : "You denied this action"}
                </span>
                <span className="block text-ink-2">{approval.title}</span>
              </span>
            </span>
            <Button
              size="sm"
              variant={approval.status === "pending" ? "primary" : "secondary"}
              onClick={() => onOpenApproval?.(approval.id)}
              iconRight={<ArrowRight />}
            >
              {approval.status === "pending" ? "Review action" : "View receipt"}
            </Button>
          </div>
        )}

        {message.text && !message.streaming && (
          <div className="flex flex-wrap items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={listening}
              icon={listening ? <VolumeX /> : <Volume2 />}
              onClick={() => {
                setListening((l) => !l);
                if (!listening)
                  toast("Listen is a demo", {
                    description: "Voice isn’t set up, so nothing plays.",
                  });
              }}
            >
              {listening ? "Stop listening" : "Listen"}
            </Button>
            {listening && <Badge tone="accent">Demo · no audio plays</Badge>}
            <Button variant="ghost" size="sm" icon={<Copy />} onClick={copy}>
              Copy
            </Button>
          </div>
        )}
      </div>
    </motion.article>
  );
}
