import React, { FormEvent, useRef, useState } from "react";
import { ArrowUp, Paperclip, X } from "lucide-react";
import type { Attachment } from "../../types";
import { Button } from "../ui/Button";
import { heroExamples } from "../../data/overview";
import { formatBytes } from "../../utils/format";

interface HeroComposerProps {
  onSubmit: (text: string, attachments: Attachment[]) => void;
  onFocusChange: (focused: boolean) => void;
  onTypingChange: (hasText: boolean) => void;
}

export function HeroComposer({
  onSubmit,
  onFocusChange,
  onTypingChange,
}: HeroComposerProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim()) return;
    onSubmit(text.trim(), attachments);
    setText("");
    setAttachments([]);
  };

  const update = (v: string) => {
    setText(v);
    onTypingChange(v.trim().length > 0);
  };

  return (
    <div>
      <form
        onSubmit={submit}
        className="rounded-[20px] border border-line bg-surface shadow-lift transition-[border-color,box-shadow] duration-200 ease-out focus-within:border-accent/60 focus-within:ring-4 focus-within:ring-accent/10"
      >
        <label htmlFor="hero-task" className="sr-only">
          Give Blip a task
        </label>
        <textarea
          id="hero-task"
          ref={areaRef}
          rows={2}
          value={text}
          onChange={(e) => update(e.target.value)}
          onFocus={() => onFocusChange(true)}
          onBlur={() => onFocusChange(false)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Give Blip a task…"
          className="block w-full resize-none bg-transparent px-5 pt-4 text-[16px] leading-relaxed text-ink placeholder:text-ink-3 focus:outline-none"
        />
        {attachments.length > 0 && (
          <ul
            className="flex flex-wrap gap-2 px-4 pt-2"
            aria-label="Attached files"
          >
            {attachments.map((a) => (
              <li
                key={a.name}
                className="inline-flex h-8 items-center gap-2 rounded-lg bg-ink/[0.05] pl-2.5 pr-1 text-[12.5px]"
              >
                <Paperclip className="h-3.5 w-3.5 text-ink-3" aria-hidden />
                <span className="max-w-[160px] truncate">{a.name}</span>
                <span className="text-ink-3">{formatBytes(a.size)}</span>
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
        <div className="flex items-center justify-between gap-2 px-3 pb-3 pt-2">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              icon={<Paperclip />}
              onClick={() => fileRef.current?.click()}
            >
              Attach
            </Button>
            <span className="hidden text-[12px] text-ink-3 sm:inline">
              Files stay in your browser
            </span>
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
          </div>
          <Button
            variant="primary"
            type="submit"
            disabled={!text.trim()}
            iconRight={<ArrowUp />}
          >
            Run task
          </Button>
        </div>
      </form>
      <div className="mt-4 flex flex-wrap items-center gap-x-1 gap-y-1 text-[13px]">
        <span className="mr-1 text-ink-3">Try</span>
        {heroExamples.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => {
              update(ex);
              areaRef.current?.focus();
            }}
            className="min-h-[36px] rounded-lg px-2 text-ink-2 underline decoration-line-strong underline-offset-4 transition-colors duration-150 hover:text-ink hover:decoration-ink-3"
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}
