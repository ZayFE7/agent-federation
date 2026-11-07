import React, {
  KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  CornerDownLeft,
  FileText,
  Keyboard,
  MessageSquarePlus,
  Moon,
  Plus,
  Repeat,
  Search,
  Sparkles,
  Target,
  Upload,
  MessageSquare,
  Inbox,
  Info,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useApp, SCREENS } from "../../contexts/AppContext";
import { useRun } from "../../contexts/RunContext";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { NAV_ITEMS } from "./navConfig";
import { matches, truncate } from "../../utils/format";

interface PaletteItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  keywords?: string;
  run: () => void;
}

const GROUP_ORDER = [
  "Actions",
  "Jump to",
  "Approvals",
  "Conversations",
  "Goals",
  "Automations",
  "Library",
];

export function CommandPalette() {
  const { paletteOpen, setPaletteOpen } = useApp();
  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      {paletteOpen && <PalettePanel onClose={() => setPaletteOpen(false)} />}
    </AnimatePresence>,
    document.body,
  );
}

function PalettePanel({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const { startTask, createConversation } = useRun();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  useFocusTrap(panelRef, true);

  const items = useMemo<PaletteItem[]>(() => {
    const go =
      (screen: Parameters<typeof app.navigate>[0], id?: string) => () =>
        app.navigate(screen, id);
    const list: PaletteItem[] = [
      {
        id: "new-chat",
        group: "Actions",
        label: "New chat",
        icon: MessageSquarePlus,
        keywords: "conversation start",
        run: () => {
          const existing = app.conversations.find(
            (c) => c.messages.length === 0,
          );
          app.navigate("chat", existing?.id ?? createConversation());
        },
      },
      {
        id: "new-goal",
        group: "Actions",
        label: "New goal",
        icon: Target,
        keywords: "create objective",
        run: go("goals", "new"),
      },
      {
        id: "new-routine",
        group: "Actions",
        label: "New routine",
        icon: Repeat,
        keywords: "automation schedule watcher webhook",
        run: go("automations", "new"),
      },
      {
        id: "upload",
        group: "Actions",
        label: "Upload a file to Library",
        icon: Upload,
        keywords: "file add",
        run: go("library", "upload"),
      },
      {
        id: "theme",
        group: "Actions",
        label:
          app.resolvedTheme === "dark"
            ? "Switch to light theme"
            : "Switch to dark theme",
        icon: Moon,
        keywords: "appearance dark light mode",
        run: () =>
          app.updateSettings({
            theme: app.resolvedTheme === "dark" ? "light" : "dark",
          }),
      },
      {
        id: "shortcuts",
        group: "Actions",
        label: "Keyboard shortcuts",
        icon: Keyboard,
        keywords: "help keys",
        run: () => app.setShortcutsOpen(true),
      },
      {
        id: "about",
        group: "Actions",
        label: "About this demo",
        icon: Info,
        keywords: "simulated help",
        run: () => app.setDemoInfoOpen(true),
      },
      ...SCREENS.map((s) => ({
        id: `nav-${s}`,
        group: "Jump to",
        label: NAV_ITEMS[s].label,
        hint: NAV_ITEMS[s].description,
        icon: NAV_ITEMS[s].icon,
        run: go(s),
      })),
      ...app.approvals
        .filter((a) => a.status === "pending")
        .map((a) => ({
          id: `ap-${a.id}`,
          group: "Approvals",
          label: a.title,
          hint: `${a.app} · ${a.affectedLabel}`,
          icon: Inbox,
          run: go("approvals", a.id),
        })),
      ...app.conversations.map((c) => ({
        id: `c-${c.id}`,
        group: "Conversations",
        label: c.title,
        hint: truncate(
          c.messages[c.messages.length - 1]?.text ?? "Empty chat",
          60,
        ),
        icon: MessageSquare,
        keywords: c.messages
          .map((m) => m.text)
          .join(" ")
          .slice(0, 1200),
        run: go("chat", c.id),
      })),
      ...app.goals.map((g) => ({
        id: `g-${g.id}`,
        group: "Goals",
        label: g.title,
        hint: g.currentStep,
        icon: Target,
        keywords: g.brief,
        run: go("goals", g.id),
      })),
      ...app.automations.map((a) => ({
        id: `r-${a.id}`,
        group: "Automations",
        label: a.name,
        icon: Repeat,
        keywords: a.instructions,
        run: go("automations", a.id),
      })),
      ...app.library.map((f) => ({
        id: `f-${f.id}`,
        group: "Library",
        label: f.name,
        hint: f.originTask,
        icon: FileText,
        keywords: f.kind,
        run: go("library", f.id),
      })),
    ];
    return list;
  }, [app, createConversation]);

  const results = useMemo(() => {
    const q = query.trim();
    let filtered: PaletteItem[];
    if (!q) {
      filtered = items
        .filter(
          (i) =>
            ["Actions", "Jump to"].includes(i.group) || i.group === "Approvals",
        )
        .concat(items.filter((i) => i.group === "Conversations").slice(0, 4));
    } else {
      const byGroup = new Map<string, PaletteItem[]>();
      items.forEach((i) => {
        if (!matches(q, i.label, i.hint, i.keywords)) return;
        const arr = byGroup.get(i.group) ?? [];
        if (arr.length < 6) arr.push(i);
        byGroup.set(i.group, arr);
      });
      filtered = GROUP_ORDER.flatMap((g) => byGroup.get(g) ?? []);
      filtered.sort(
        (a, b) =>
          Number(b.label.toLowerCase() === q.toLowerCase()) -
          Number(a.label.toLowerCase() === q.toLowerCase()),
      );
      filtered.push({
        id: "task",
        group: "Give Blip a task",
        label: `“${truncate(q, 60)}”`,
        hint: "Starts a simulated run in a new chat",
        icon: Sparkles,
        run: () => app.navigate("chat", startTask(q)),
      });
    }
    return filtered;
  }, [items, query, app, startTask]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    window.setTimeout(item.run, 0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[active]);
    }
  };

  let lastGroup = "";

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center px-3 pt-[8vh] sm:pt-[12vh]">
      <motion.div
        aria-hidden
        className="absolute inset-0 bg-[#141418]/35"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        onClick={onClose}
      />
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
        initial={{ opacity: 0, y: -8, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -6, scale: 0.985 }}
        transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
        className="relative flex max-h-[70vh] w-full max-w-[620px] flex-col overflow-hidden rounded-[20px] border border-line bg-surface shadow-pop"
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search
            className="h-[18px] w-[18px] shrink-0 text-ink-3"
            aria-hidden
          />
          <input
            data-autofocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={
              results[active] ? `pal-${results[active].id}` : undefined
            }
            aria-autocomplete="list"
            aria-label="Search pages, threads, goals and files, or type a task"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search, jump, or type a task for Blip…"
            className="h-14 flex-1 bg-transparent text-[15px] text-ink placeholder:text-ink-3 focus:outline-none"
          />
          <kbd className="hidden rounded-md border border-line px-1.5 py-0.5 font-mono text-[10.5px] text-ink-3 sm:inline">
            Esc
          </kbd>
        </div>
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Results"
          className="flex-1 overflow-y-auto p-2 scroll-thin"
        >
          {results.length === 1 && query && (
            <li
              role="presentation"
              className="px-3 pb-1 pt-2 text-[12.5px] text-ink-3"
            >
              No pages or threads match — you can still hand it to Blip.
            </li>
          )}
          {results.map((item, index) => {
            const showGroup = item.group !== lastGroup;
            lastGroup = item.group;
            const Icon = item.icon;
            const selected = index === active;
            return (
              <React.Fragment key={item.id}>
                {showGroup && (
                  <li
                    role="presentation"
                    className="px-3 pb-1.5 pt-3 font-mono text-[10.5px] tracking-[0.06em] text-ink-3"
                  >
                    {item.group}
                  </li>
                )}
                <li
                  id={`pal-${item.id}`}
                  role="option"
                  aria-selected={selected}
                  data-index={index}
                  onMouseMove={() => setActive(index)}
                  onClick={() => choose(item)}
                  className={`flex min-h-[44px] cursor-pointer items-center gap-3 rounded-xl px-3 py-2 ${selected ? "bg-ink/[0.05]" : ""}`}
                >
                  <span
                    className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${item.id === "task" ? "bg-accent-soft text-accent-ink" : "bg-ink/[0.05] text-ink-2"}`}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium text-ink">
                      {item.label}
                    </span>
                    {item.hint && (
                      <span className="block truncate text-[12.5px] text-ink-3">
                        {item.hint}
                      </span>
                    )}
                  </span>
                  {selected && (
                    <CornerDownLeft
                      className="h-4 w-4 shrink-0 text-ink-3"
                      aria-hidden
                    />
                  )}
                </li>
              </React.Fragment>
            );
          })}
          {results.length === 0 && (
            <li
              role="presentation"
              className="flex flex-col items-center gap-2 px-6 py-10 text-center text-sm text-ink-2"
            >
              <Plus className="h-5 w-5 text-ink-3" aria-hidden />
              Type to search, or describe a task.
            </li>
          )}
        </ul>
        <div className="hidden items-center gap-4 border-t border-line px-4 py-2.5 text-[12px] text-ink-3 sm:flex">
          <span>
            <kbd className="font-mono">↑↓</kbd> move
          </span>
          <span>
            <kbd className="font-mono">Enter</kbd> open
          </span>
          <span>
            <kbd className="font-mono">Esc</kbd> close
          </span>
          <span className="ml-auto">Searches stay on this device</span>
        </div>
      </motion.div>
    </div>
  );
}
