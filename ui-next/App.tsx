import React, { useEffect } from "react";
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import { Toaster, toast } from "sonner";
import { AppProvider, useApp } from "./contexts/AppContext";
import { RunProvider } from "./contexts/RunContext";
import { Sidebar } from "./components/shell/Sidebar";
import { Header } from "./components/shell/Header";
import { MobileNav } from "./components/shell/MobileNav";
import { CommandPalette } from "./components/shell/CommandPalette";
import {
  ShortcutsDialog,
  DemoInfoDialog,
} from "./components/shell/InfoDialogs";
import { Overview } from "./pages/Overview";
import { Conversations } from "./pages/Conversations";
import { Approvals } from "./pages/Approvals";
import { Goals } from "./pages/Goals";
import { Automations } from "./pages/Automations";
import { Library } from "./pages/Library";
import { Connections } from "./pages/Connections";
import { Capabilities } from "./pages/Capabilities";
import { Memory } from "./pages/Memory";
import { Settings } from "./pages/Settings";
import { Motion } from "./pages/Motion";
import type { ScreenId } from "./types";
const screens: Record<ScreenId, React.ComponentType> = {
  overview: Overview,
  chat: Conversations,
  approvals: Approvals,
  goals: Goals,
  automations: Automations,
  library: Library,
  connections: Connections,
  capabilities: Capabilities,
  memory: Memory,
  settings: Settings,
  motion: Motion,
};
function Workspace() {
  const app = useApp(),
    Screen = screens[app.route.screen];
  useEffect(() => {
    const warning = () =>
      toast.error(
        "Browser storage is unavailable or full. Changes are kept in memory only. Export your local data before leaving.",
        { id: "storage-warning", duration: 10000 },
      );
    window.addEventListener("blip:storage-error", warning);
    return () => window.removeEventListener("blip:storage-error", warning);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.motion = app.reducedMotion
      ? "reduced"
      : "full";
  }, [app.reducedMotion]);
  useEffect(() => {
    document.title = `Blip · ${app.route.screen === "chat" ? "Conversations" : app.route.screen[0].toUpperCase() + app.route.screen.slice(1)}`;
    document.getElementById("main-content")?.focus({ preventScroll: true });
  }, [app.route.screen]);
  return (
    <MotionConfig reducedMotion={app.reducedMotion ? "always" : "never"}>
      <a
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:bg-surface focus:border focus:border-accent focus:rounded-xl focus:p-3"
      >
        Skip to content
      </a>
      <Sidebar />
      <div className="min-h-dvh pb-16 md:pb-0 md:ml-[76px] lg:ml-[236px]">
        <Header />
        <main id="main-content" tabIndex={-1} className="outline-none">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={app.route.screen}
              initial={{ opacity: 0, y: app.reducedMotion ? 0 : 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: app.reducedMotion ? 0 : -4 }}
              transition={{
                duration: app.reducedMotion ? 0 : 0.18,
                ease: [0.23, 1, 0.32, 1],
              }}
            >
              <Screen />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <MobileNav />
      <CommandPalette />
      <ShortcutsDialog />
      <DemoInfoDialog />
      <Toaster
        richColors
        closeButton
        theme={app.resolvedTheme}
        position="bottom-right"
        toastOptions={{ style: { fontFamily: "inherit" } }}
      />
    </MotionConfig>
  );
}
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main
        style={{
          padding: 40,
          fontFamily: "system-ui",
          maxWidth: 650,
          margin: "auto",
        }}
      >
        <h1>This preview hit a snag.</h1>
        <p style={{ margin: "16px 0" }}>
          Your local data has not been sent anywhere. Reload the page to try
          again.
        </p>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: "12px 20px",
            border: "1px solid #ddd",
            borderRadius: 12,
          }}
        >
          Reload preview
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
export default function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <RunProvider>
          <Workspace />
        </RunProvider>
      </AppProvider>
    </ErrorBoundary>
  );
}
