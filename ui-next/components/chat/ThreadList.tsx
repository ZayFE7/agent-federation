import React, { useMemo, useState } from "react";
import {
  CheckSquare,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { Conversation } from "../../types";
import { useRun } from "../../contexts/RunContext";
import { Button } from "../ui/Button";
import { formatRelative } from "../../utils/time";
import { matches, truncate } from "../../utils/format";

interface ThreadListProps {
  conversations: Conversation[];
  activeId?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (ids: string[]) => void;
  onTogglePin: (id: string) => void;
}

export function ThreadList({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onTogglePin,
}: ThreadListProps) {
  const { run } = useRun();
  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const filtered = useMemo(
    () =>
      [...conversations]
        .filter((c) =>
          matches(query, c.title, c.messages.map((m) => m.text).join(" ")),
        )
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        ),
    [conversations, query],
  );
  const pinned = filtered.filter((c) => c.pinned);
  const recent = filtered.filter((c) => !c.pinned);

  const toggleSel = (id: string) =>
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : [...s, id],
    );

  const renderRow = (c: Conversation) => {
    const active = c.id === activeId;
    const last = c.messages[c.messages.length - 1];
    const working = run?.conversationId === c.id;
    const checked = selected.includes(c.id);
    return (
      <li key={c.id} className="group relative">
        <button
          type="button"
          onClick={() => (selecting ? toggleSel(c.id) : onSelect(c.id))}
          aria-current={active && !selecting ? "true" : undefined}
          aria-pressed={selecting ? checked : undefined}
          className={`flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors duration-150 ${
            active && !selecting
              ? "border-line bg-surface shadow-soft"
              : "border-transparent hover:bg-ink/[0.04]"
          }`}
        >
          {selecting && (
            <span
              className={`mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] border ${checked ? "border-ink bg-ink text-canvas" : "border-line-strong"}`}
              aria-hidden
            >
              {checked && <span className="h-2 w-2 rounded-[2px] bg-canvas" />}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-[14px] font-medium">
                {c.title}
              </span>
              {working && (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent motion-safe:animate-pulse"
                  aria-label="Run in progress"
                />
              )}
            </span>
            <span className="mt-0.5 block truncate text-[12.5px] text-ink-3">
              {last ? truncate(last.text || "Working…", 70) : "No messages yet"}
            </span>
          </span>
          <span className="tabular shrink-0 pt-0.5 text-[11.5px] text-ink-3">
            {formatRelative(c.updatedAt)}
          </span>
        </button>
        {!selecting && (
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 gap-0.5 rounded-lg bg-surface opacity-0 shadow-soft transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={c.pinned ? `Unpin ${c.title}` : `Pin ${c.title}`}
              onClick={() => onTogglePin(c.id)}
            >
              {c.pinned ? <PinOff /> : <Pin />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete ${c.title}`}
              onClick={() => onDelete([c.id])}
            >
              <Trash2 />
            </Button>
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-3 px-4 pb-3 pt-5">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-[17px] font-semibold tracking-[-0.01em]">
            Conversations
          </h1>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={
                selecting ? "Cancel selection" : "Select conversations"
              }
              aria-pressed={selecting}
              onClick={() => {
                setSelecting((s) => !s);
                setSelected([]);
              }}
            >
              {selecting ? <X /> : <CheckSquare />}
            </Button>
            <Button variant="primary" size="sm" icon={<Plus />} onClick={onNew}>
              New
            </Button>
          </div>
        </div>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3"
            aria-hidden
          />
          <label htmlFor="thread-search" className="sr-only">
            Search conversations
          </label>
          <input
            id="thread-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations"
            className="h-11 w-full rounded-xl border border-line bg-surface pl-9 pr-3 text-[13.5px] placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent/15 md:h-10"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-4 scroll-thin">
        {filtered.length === 0 && (
          <div className="px-4 py-10 text-center">
            <p className="text-[14px] font-medium">
              No conversations match “{query}”
            </p>
            <button
              type="button"
              onClick={() => setQuery("")}
              className="mt-2 min-h-[36px] text-[13px] text-ink-2 underline underline-offset-4"
            >
              Clear search
            </button>
          </div>
        )}
        {pinned.length > 0 && (
          <section aria-label="Pinned">
            <p className="px-3 pb-1.5 pt-2 font-mono text-[10.5px] tracking-[0.06em] text-ink-3">
              Pinned
            </p>
            <ul className="space-y-0.5">{pinned.map(renderRow)}</ul>
          </section>
        )}
        {recent.length > 0 && (
          <section aria-label="Recent">
            <p className="px-3 pb-1.5 pt-4 font-mono text-[10.5px] tracking-[0.06em] text-ink-3">
              Recent
            </p>
            <ul className="space-y-0.5">{recent.map(renderRow)}</ul>
          </section>
        )}
      </div>
      {selecting && (
        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
          <span className="text-[13px] text-ink-2">
            {selected.length} selected
          </span>
          <Button
            variant="danger"
            size="sm"
            icon={<Trash2 />}
            disabled={selected.length === 0}
            onClick={() => onDelete(selected)}
          >
            Delete
          </Button>
        </div>
      )}
    </div>
  );
}
