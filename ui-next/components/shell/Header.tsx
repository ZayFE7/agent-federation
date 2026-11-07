import React from "react";
import { ChevronRight, Moon, Search, Sun } from "lucide-react";
import { useApp } from "../../contexts/AppContext";
import { NAV_ITEMS } from "./navConfig";
import { AgentStatusChip } from "./AgentStatusChip";
import { MascotStill } from "../mascot/MascotStill";
import { Button } from "../ui/Button";
import { modKey } from "../../utils/platform";

export function Header() {
  const {
    route,
    navigate,
    setPaletteOpen,
    updateSettings,
    resolvedTheme,
    setDemoInfoOpen,
    goals,
    conversations,
    automations,
    approvals,
    library,
  } = useApp();
  const item = NAV_ITEMS[route.screen];

  const detail = (() => {
    const id = route.id;
    if (!id || id === "new" || id === "upload") return undefined;
    if (route.screen === "goals") return goals.find((g) => g.id === id)?.title;
    if (route.screen === "chat")
      return conversations.find((c) => c.id === id)?.title;
    if (route.screen === "automations")
      return automations.find((a) => a.id === id)?.name;
    if (route.screen === "approvals")
      return approvals.find((a) => a.id === id)?.title;
    if (route.screen === "library")
      return library.find((f) => f.id === id)?.name;
    return undefined;
  })();

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-canvas px-4 md:h-16 md:gap-3 md:px-6 lg:px-8">
      <button
        type="button"
        className="-ml-1 md:hidden"
        onClick={() => navigate("overview")}
        aria-label="Blip — go to Overview"
      >
        <MascotStill size={36} />
      </button>
      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1.5 text-[13.5px]">
          <li className="hidden text-ink-3 sm:block">Blip</li>
          <li className="hidden text-ink-3 sm:block" aria-hidden>
            <ChevronRight className="h-3.5 w-3.5" />
          </li>
          <li className="min-w-0 shrink-0">
            {detail ? (
              <button
                type="button"
                onClick={() => navigate(route.screen)}
                className="text-ink-2 transition-colors hover:text-ink"
              >
                {item.label}
              </button>
            ) : (
              <span className="font-medium text-ink" aria-current="page">
                {item.label}
              </span>
            )}
          </li>
          {detail && (
            <>
              <li className="hidden text-ink-3 sm:block" aria-hidden>
                <ChevronRight className="h-3.5 w-3.5" />
              </li>
              <li
                className="hidden min-w-0 truncate font-medium text-ink sm:block"
                aria-current="page"
              >
                {detail}
              </li>
            </>
          )}
        </ol>
      </nav>

      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        className="hidden h-9 w-[240px] items-center gap-2 rounded-xl border border-line bg-surface px-3 text-[13px] text-ink-3 transition-[border-color] duration-150 hover:border-line-strong lg:flex xl:w-[300px]"
      >
        <Search className="h-4 w-4" aria-hidden />
        <span className="flex-1 text-left">Search or jump to…</span>
        <kbd className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[10.5px]">
          {modKey} K
        </kbd>
      </button>
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        aria-label="Open command palette"
        onClick={() => setPaletteOpen(true)}
      >
        <Search />
      </Button>

      <button
        type="button"
        onClick={() => setDemoInfoOpen(true)}
        className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full bg-accent-soft px-3 text-[12.5px] font-medium text-accent-ink transition-colors duration-150 hover:bg-accent-soft/70"
        aria-label="Interactive demo — learn what is simulated"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
        <span className="sm:hidden">Demo</span>
        <span className="hidden sm:inline">Interactive demo</span>
      </button>

      <AgentStatusChip className="hidden sm:inline-flex" />

      <Button
        variant="ghost"
        size="icon"
        className="hidden md:inline-flex"
        aria-label={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} theme`}
        onClick={() =>
          updateSettings({ theme: resolvedTheme === "dark" ? "light" : "dark" })
        }
      >
        {resolvedTheme === "dark" ? <Sun /> : <Moon />}
      </Button>
    </header>
  );
}
