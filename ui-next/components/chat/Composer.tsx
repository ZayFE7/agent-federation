import React, { RefObject, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUp,
  ChevronDown,
  Clock,
  Paperclip,
  Play,
  Square,
  X,
} from "lucide-react";
import type { Attachment, QueuedTask } from "../../types";
import { useApp } from "../../contexts/AppContext";
import { Button } from "../ui/Button";
import { MODELS } from "../../data/settings";
import { formatBytes, truncate } from "../../utils/format";

interface ComposerProps {
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  running: boolean;
  offline: boolean;
  queued: QueuedTask[];
  onRemoveQueued: (id: string) => void;
  onRunQueued: () => void;
  onFocusChange: (focused: boolean) => void;
  inputRef: RefObject<HTMLTextAreaElement>;
  prefill?: { text: string; key: number };
}

export function Composer({
  onSend,
  onStop,
  running,
  offline,
  queued,
  onRemoveQueued,
  onRunQueued,
  onFocusChange,
  inputRef,
  prefill,
}: ComposerProps) {
  const { settings, updateSettings } = useApp();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (prefill) {
      setText(prefill.text);
      inputRef.current?.focus();
    }
  }, [prefill, inputRef]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
  }, [text, inputRef]);

  const send = () => {
    if (!text.trim()) return;
    onSend(text, attachments);
    setText("");
    setAttachments([]);
  };

  const modelOptions = [
    ...MODELS.map((m) => ({ id: m.id, label: m.label })),
    ...settings.providers.flatMap((p) =>
      p.models.map((id) => ({ id, label: `${id} · ${p.name}` })),
    ),
  ];

  return (
    <div className="space-y-2">
      <AnimatePresence initial={false}>
        {queued.length > 0 && (
          <motion.ul
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.18 }}
            aria-label="Queued follow-ups"
            className="space-y-1.5"
          >
            {queued.map((q) => (
              <li
                key={q.id}
                className="flex items-center gap-2 rounded-xl border border-dashed border-line-strong bg-surface px-3 py-1.5 text-[13px]"
              >
                <Clock
                  className="h-3.5 w-3.5 shrink-0 text-ink-3"
                  aria-hidden
                />
                <span className="text-ink-3">Queued</span>
                <span className="min-w-0 flex-1 truncate text-ink">
                  {truncate(q.text, 80)}
                </span>
                {!running && !offline && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Play />}
                    onClick={onRunQueued}
                  >
                    Run now
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove queued message: ${truncate(q.text, 40)}`}
                  onClick={() => onRemoveQueued(q.id)}
                >
                  <X />
                </Button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>

      <div className="rounded-[18px] border border-line bg-surface shadow-lift transition-[border-color,box-shadow] duration-200 ease-out focus-within:border-accent/60 focus-within:ring-4 focus-within:ring-accent/10">
        <label htmlFor="chat-composer" className="sr-only">
          Message Blip
        </label>
        <textarea
          id="chat-composer"
          ref={inputRef}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => onFocusChange(true)}
          onBlur={() => onFocusChange(false)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={
            offline
              ? "You’re offline — messages will queue…"
              : running
                ? "Add a follow-up — it will queue…"
                : "Ask Blip to do something…"
          }
          className="block max-h-[200px] w-full resize-none bg-transparent px-4 pt-3.5 text-[15px] leading-relaxed text-ink placeholder:text-ink-3 focus:outline-none"
        />
        {attachments.length > 0 && (
          <ul
            className="flex flex-wrap gap-2 px-3 pt-2"
            aria-label="Attached files"
          >
            {attachments.map((a) => (
              <li
                key={a.name}
                className="inline-flex h-8 items-center gap-2 rounded-lg bg-ink/[0.05] pl-2.5 pr-1 text-[12.5px]"
              >
                <Paperclip className="h-3.5 w-3.5 text-ink-3" aria-hidden />
                <span className="max-w-[160px] truncate">{a.name}</span>
                <span className="text-ink-3">
                  {formatBytes(a.size)} · local
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  onClick={() =>
                    setAttachments((l) => l.filter((x) => x.name !== a.name))
                  }
                  className="grid h-7 w-7 place-items-center rounded-md hover:bg-ink/[0.06]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-1.5 px-2 pb-2 pt-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Attach files (stay in your browser)"
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip />
          </Button>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []).map((f) => ({
                name: f.name,
                size: f.size,
                type: f.type,
              }));
              setAttachments((l) => [
                ...l,
                ...files.filter((f) => !l.some((x) => x.name === f.name)),
              ]);
              e.target.value = "";
            }}
          />
          <div className="relative">
            <label htmlFor="model-switch" className="sr-only">
              Model
            </label>
            <select
              id="model-switch"
              value={settings.model}
              onChange={(e) => updateSettings({ model: e.target.value })}
              className="h-11 cursor-pointer appearance-none rounded-lg bg-transparent pl-2.5 pr-7 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-ink/[0.05] hover:text-ink focus:outline-none md:h-8"
            >
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <ChevronDown
              className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3"
              aria-hidden
            />
          </div>
          <span className="ml-auto hidden text-[11.5px] text-ink-3 lg:inline">
            Enter to send · Shift+Enter for a new line
          </span>
          <div className="ml-auto flex items-center gap-1.5 lg:ml-2">
            {running && (
              <Button
                variant="secondary"
                size="sm"
                icon={<Square className="fill-current" />}
                onClick={onStop}
              >
                Stop
              </Button>
            )}
            <Button
              variant="primary"
              size="icon-sm"
              aria-label={
                running || offline ? "Queue follow-up" : "Send message"
              }
              disabled={!text.trim()}
              onClick={send}
            >
              <ArrowUp />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
