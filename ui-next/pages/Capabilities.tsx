import React, { useMemo, useState } from "react";
import {
  ArrowRight,
  Brain,
  CalendarClock,
  CalendarDays,
  Globe,
  History,
  Mail,
  Network,
  PenLine,
  Save,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
  Volume2,
} from "lucide-react";
import type { Capability, CapabilityIcon } from "../types";
import { useApp } from "../contexts/AppContext";
import { capabilities } from "../data/capabilities";
import { Page, PageHeader } from "../components/ui/Page";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Dialog } from "../components/ui/Dialog";
import { EmptyState } from "../components/ui/EmptyState";
import { matches } from "../utils/format";

const ICONS: Record<CapabilityIcon, typeof Brain> = {
  memory: Brain,
  shell: Terminal,
  files: PenLine,
  web: Globe,
  schedule: CalendarClock,
  autosave: Save,
  snapshot: History,
  subagents: Network,
  email: Mail,
  mcp: Server,
  skills: Sparkles,
  calendar: CalendarDays,
  tts: Volume2,
};

const APPROVAL = {
  always: { label: "Always asks first", tone: "attention" as const },
  destructive: {
    label: "Asks before destructive actions",
    tone: "neutral" as const,
  },
  none: { label: "No approval needed", tone: "muted" as const },
};

export function Capabilities() {
  const { navigate } = useApp();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Capability | null>(null);

  const filtered = useMemo(
    () =>
      capabilities.filter((c) =>
        matches(query, c.name, c.summary, c.group, c.can.join(" ")),
      ),
    [query],
  );
  const groups = Array.from(new Set(filtered.map((c) => c.group)));
  const setup = capabilities.filter((c) => c.status === "setup").length;

  return (
    <Page>
      <PageHeader
        index="08"
        eyebrow="Capabilities"
        title="What Blip can do — and where it stops."
        description={`${capabilities.length - setup} abilities ready, ${setup} needs setup. Each one lists its safety boundary in plain language.`}
      />
      <div className="relative mb-8 max-w-md">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3"
          aria-hidden
        />
        <label htmlFor="cap-search" className="sr-only">
          Search capabilities
        </label>
        <input
          id="cap-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search — e.g. email, files, schedule"
          className="h-11 w-full rounded-xl border border-line bg-surface pl-9 pr-3 text-[14px] placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent/15"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-[22px] border border-dashed border-line-strong">
          <EmptyState
            icon={<Search />}
            title={`Nothing matches “${query}”`}
            body="Try a broader word, like “files” or “mail”."
            action={
              <Button variant="ghost" onClick={() => setQuery("")}>
                Clear search
              </Button>
            }
          />
        </div>
      ) : (
        <div className="space-y-10">
          {groups.map((g) => (
            <section key={g} aria-labelledby={`cap-${g}`}>
              <h2
                id={`cap-${g}`}
                className="mb-3 font-mono text-[11px] tracking-[0.06em] text-ink-3"
              >
                {g}
              </h2>
              <ul className="divide-y divide-line overflow-hidden rounded-[20px] border border-line bg-surface">
                {filtered
                  .filter((c) => c.group === g)
                  .map((c) => {
                    const Icon = ICONS[c.icon];
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => setOpen(c)}
                          className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 px-5 py-4 text-left transition-colors duration-150 hover:bg-ink/[0.02] md:grid-cols-[auto_minmax(0,1fr)_220px_130px]"
                        >
                          <span
                            className={`grid h-10 w-10 place-items-center rounded-xl ${c.status === "setup" ? "bg-amber-soft text-amber-ink" : "bg-ink/[0.05] text-ink-2"}`}
                            aria-hidden
                          >
                            <Icon className="h-[18px] w-[18px]" />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-[14.5px] font-medium">
                              {c.name}
                            </span>
                            <span className="block truncate text-[13px] text-ink-3">
                              {c.summary}
                            </span>
                          </span>
                          <span className="hidden text-[12.5px] text-ink-2 md:block">
                            {APPROVAL[c.approval].label}
                          </span>
                          <span className="justify-self-end">
                            {c.status === "available" ? (
                              <Badge tone="healthy" dot>
                                Available
                              </Badge>
                            ) : (
                              <Badge tone="attention" dot>
                                Setup required
                              </Badge>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
              </ul>
            </section>
          ))}
        </div>
      )}

      <Dialog
        open={Boolean(open)}
        onClose={() => setOpen(null)}
        variant="side"
        eyebrow={open ? open.group.toLowerCase() : undefined}
        title={open?.name ?? ""}
        description={open?.summary}
        footer={
          open?.link && (
            <Button
              variant="primary"
              iconRight={<ArrowRight />}
              onClick={() => {
                const link = open.link;
                setOpen(null);
                if (link)
                  navigate(link, link === "settings" ? "models" : undefined);
              }}
            >
              {open.linkLabel}
            </Button>
          )
        }
      >
        {open && (
          <div className="space-y-7">
            <div className="flex flex-wrap gap-2">
              {open.status === "available" ? (
                <Badge tone="healthy" dot>
                  Available
                </Badge>
              ) : (
                <Badge tone="attention" dot>
                  Setup required
                </Badge>
              )}
              <Badge tone={APPROVAL[open.approval].tone}>
                {APPROVAL[open.approval].label}
              </Badge>
            </div>
            <section>
              <h3 className="mb-2 text-[13px] font-semibold">What it can do</h3>
              <ul className="space-y-2">
                {open.can.map((c) => (
                  <li key={c} className="flex gap-2.5 text-[14px]">
                    <span
                      className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-ink-3"
                      aria-hidden
                    />
                    {c}
                  </li>
                ))}
              </ul>
            </section>
            <section className="rounded-2xl bg-sage-soft p-4">
              <h3 className="flex items-center gap-2 text-[13px] font-semibold text-sage-ink">
                <ShieldCheck className="h-4 w-4" aria-hidden /> Safety boundary
              </h3>
              <p className="mt-1.5 text-[14px] leading-relaxed text-ink">
                {open.boundary}
              </p>
            </section>
            <p className="text-[12.5px] text-ink-3">
              Approval rules apply everywhere — chats, goals, routines and
              sub-agents — and can’t be overridden by skills.
            </p>
          </div>
        )}
      </Dialog>
    </Page>
  );
}
