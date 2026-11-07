import React, { useState } from "react";
import { motion } from "framer-motion";
import { Ellipsis, Info, Keyboard, Moon, Search, Sun } from "lucide-react";
import type { ScreenId } from "../../types";
import { useApp } from "../../contexts/AppContext";
import { MOBILE_PRIMARY, NAV_ITEMS } from "./navConfig";
import { Dialog } from "../ui/Dialog";
import { AgentStatusChip } from "./AgentStatusChip";

const MORE: ScreenId[] = [
  "approvals",
  "automations",
  "connections",
  "capabilities",
  "memory",
  "motion",
  "settings",
];

export function MobileNav() {
  const {
    route,
    navigate,
    approvals,
    setPaletteOpen,
    updateSettings,
    resolvedTheme,
    setShortcutsOpen,
    setDemoInfoOpen,
  } = useApp();
  const [open, setOpen] = useState(false);
  const pending = approvals.filter((a) => a.status === "pending").length;
  const moreActive = MORE.includes(route.screen);

  const go = (id: ScreenId) => {
    setOpen(false);
    navigate(id);
  };

  return (
    <>
      <nav
        aria-label="Primary"
        className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface md:hidden"
      >
        <ul className="grid grid-cols-5">
          {MOBILE_PRIMARY.map((id) => {
            const item = NAV_ITEMS[id];
            const Icon = item.icon;
            const active = route.screen === id;
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => navigate(id)}
                  aria-current={active ? "page" : undefined}
                  className={`relative flex h-16 w-full flex-col items-center justify-center gap-1 text-[11px] font-medium ${active ? "text-ink" : "text-ink-3"}`}
                >
                  {active && (
                    <motion.span
                      layoutId="mobile-nav"
                      className="absolute top-0 h-0.5 w-8 rounded-full bg-ink"
                      transition={{
                        type: "spring",
                        stiffness: 520,
                        damping: 42,
                      }}
                    />
                  )}
                  <Icon className="h-5 w-5" aria-hidden />
                  {item.short}
                </button>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-label={`More${pending ? `, ${pending} approvals pending` : ""}`}
              className={`relative flex h-16 w-full flex-col items-center justify-center gap-1 text-[11px] font-medium ${moreActive ? "text-ink" : "text-ink-3"}`}
            >
              {moreActive && (
                <span
                  className="absolute top-0 h-0.5 w-8 rounded-full bg-ink"
                  aria-hidden
                />
              )}
              <span className="relative">
                <Ellipsis className="h-5 w-5" aria-hidden />
                {pending > 0 && (
                  <span
                    className="absolute -right-1.5 -top-1 h-2 w-2 rounded-full bg-amber"
                    aria-hidden
                  />
                )}
              </span>
              More
            </button>
          </li>
        </ul>
      </nav>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="More"
        description="Everything else Blip can show you."
      >
        <div className="mb-4">
          <AgentStatusChip />
        </div>
        <ul className="grid grid-cols-2 gap-2">
          {MORE.map((id) => {
            const item = NAV_ITEMS[id];
            const Icon = item.icon;
            const active = route.screen === id;
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => go(id)}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-[64px] w-full flex-col items-start justify-center gap-1 rounded-2xl border px-4 py-3 text-left ${
                    active
                      ? "border-ink/20 bg-ink/[0.04]"
                      : "border-line bg-surface"
                  }`}
                >
                  <span className="flex w-full items-center gap-2 text-[14px] font-medium">
                    <Icon className="h-4 w-4" aria-hidden />
                    {item.label}
                    {id === "approvals" && pending > 0 && (
                      <span className="tabular ml-auto rounded-full bg-amber-soft px-1.5 text-[11px] font-semibold text-amber-ink">
                        {pending}
                      </span>
                    )}
                  </span>
                  <span className="text-[12px] leading-snug text-ink-3">
                    {item.description}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="mt-5 divide-y divide-line rounded-2xl border border-line">
          {[
            {
              label: "Search & commands",
              icon: Search,
              run: () => {
                setOpen(false);
                setPaletteOpen(true);
              },
            },
            {
              label:
                resolvedTheme === "dark" ? "Use light theme" : "Use dark theme",
              icon: resolvedTheme === "dark" ? Sun : Moon,
              run: () =>
                updateSettings({
                  theme: resolvedTheme === "dark" ? "light" : "dark",
                }),
            },
            {
              label: "Keyboard shortcuts",
              icon: Keyboard,
              run: () => {
                setOpen(false);
                setShortcutsOpen(true);
              },
            },
            {
              label: "About this demo",
              icon: Info,
              run: () => {
                setOpen(false);
                setDemoInfoOpen(true);
              },
            },
          ].map((row) => (
            <button
              key={row.label}
              type="button"
              onClick={row.run}
              className="flex h-12 w-full items-center gap-3 px-4 text-left text-[14px]"
            >
              <row.icon className="h-4 w-4 text-ink-2" aria-hidden />
              {row.label}
            </button>
          ))}
        </div>
      </Dialog>
    </>
  );
}
