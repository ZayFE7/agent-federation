import React from "react";
import { motion } from "framer-motion";
import { Search } from "lucide-react";
import type { MascotStateId, ScreenId } from "../../types";
import { useApp } from "../../contexts/AppContext";
import { PHASE_MASCOT, useRun } from "../../contexts/RunContext";
import { Mascot } from "../mascot/Mascot";
import { NAV_GROUPS, NAV_ITEMS } from "./navConfig";
import { AgentStatusChip } from "./AgentStatusChip";
import { modKey } from "../../utils/platform";

export function Sidebar() {
  const { route, navigate, approvals, setPaletteOpen } = useApp();
  const { agentStatus, run } = useRun();
  const pending = approvals.filter((a) => a.status === "pending").length;
  const mascotState: MascotStateId =
    agentStatus === "offline"
      ? "offline"
      : agentStatus === "running" && run
        ? PHASE_MASCOT[run.phase]
        : "idle";

  const badgeFor = (id: ScreenId) => (id === "approvals" ? pending : 0);

  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[76px] flex-col border-r border-line bg-sidebar md:flex lg:w-[236px]">
      <button
        type="button"
        onClick={() => navigate("overview")}
        className="flex h-16 shrink-0 items-center gap-2 px-[18px] text-left lg:px-4"
        aria-label="Blip — go to Overview"
      >
        <Mascot state={mascotState} size={40} decorative />
        <span className="hidden lg:block">
          <span className="block text-[18px] font-semibold leading-none tracking-[-0.03em]">
            blip
          </span>
          <span className="mt-1 block font-mono text-[10.5px] text-ink-3">
            personal agent
          </span>
        </span>
      </button>

      <nav
        aria-label="Primary"
        className="flex-1 overflow-y-auto px-3 pb-4 scroll-thin"
      >
        {NAV_GROUPS.map((group, gi) => (
          <div key={gi} className={gi ? "mt-6" : "mt-2"}>
            {group.label && (
              <p className="hidden px-3 pb-2 font-mono text-[10.5px] tracking-[0.06em] text-ink-3 lg:block">
                {group.label}
              </p>
            )}
            {gi > 0 && (
              <div className="mx-3 mb-3 h-px bg-line lg:hidden" aria-hidden />
            )}
            <ul className="space-y-0.5">
              {group.items.map((id) => {
                const item = NAV_ITEMS[id];
                const active = route.screen === id;
                const badge = badgeFor(id);
                const Icon = item.icon;
                const working = id === "chat" && agentStatus === "running";
                return (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => navigate(id)}
                      aria-current={active ? "page" : undefined}
                      aria-label={`${item.label}${badge ? `, ${badge} pending` : ""}${working ? ", run in progress" : ""}`}
                      className={`group relative flex h-11 w-full items-center justify-center gap-3 rounded-xl px-3 text-[14px] font-medium transition-colors duration-150 lg:h-10 lg:justify-start ${
                        active
                          ? "text-ink"
                          : "text-ink-2 hover:bg-ink/[0.04] hover:text-ink"
                      }`}
                    >
                      {active && (
                        <motion.span
                          layoutId="nav-active"
                          className="absolute inset-0 rounded-xl border border-line bg-surface shadow-soft"
                          transition={{
                            type: "spring",
                            stiffness: 520,
                            damping: 42,
                          }}
                        />
                      )}
                      <Icon
                        className="relative h-[18px] w-[18px] shrink-0"
                        aria-hidden
                      />
                      <span className="relative hidden lg:inline">
                        {item.label}
                      </span>
                      {badge > 0 && (
                        <>
                          <span className="tabular relative ml-auto hidden h-5 min-w-[20px] items-center justify-center rounded-full bg-amber-soft px-1.5 text-[11px] font-semibold text-amber-ink lg:inline-flex">
                            {badge}
                          </span>
                          <span
                            className="absolute right-3 top-2.5 h-2 w-2 rounded-full bg-amber lg:hidden"
                            aria-hidden
                          />
                        </>
                      )}
                      {working && (
                        <span
                          className="relative ml-auto hidden h-2 w-2 rounded-full bg-accent motion-safe:animate-pulse lg:inline-block"
                          aria-hidden
                        />
                      )}
                      <span
                        role="tooltip"
                        className="pointer-events-none absolute left-full z-10 ml-3 whitespace-nowrap rounded-lg bg-ink px-2.5 py-1.5 text-xs font-medium text-canvas opacity-0 shadow-lift transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 lg:hidden"
                      >
                        {item.label}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="shrink-0 space-y-2 border-t border-line p-3">
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="flex h-11 w-full items-center justify-center gap-2.5 rounded-xl text-[13.5px] text-ink-2 transition-colors duration-150 hover:bg-ink/[0.04] hover:text-ink lg:h-10 lg:justify-start lg:px-3"
          aria-label="Open command palette"
        >
          <Search className="h-[18px] w-[18px]" aria-hidden />
          <span className="hidden lg:inline">Search</span>
          <kbd className="ml-auto hidden rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-ink-3 lg:inline">
            {modKey} K
          </kbd>
        </button>
        <div className="hidden lg:block">
          <AgentStatusChip className="w-full justify-start" />
        </div>
      </div>
    </aside>
  );
}
