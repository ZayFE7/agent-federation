import React, {
  createContext,
  Dispatch,
  ReactNode,
  SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  AppConnection,
  Approval,
  Automation,
  ChatScenario,
  Conversation,
  Goal,
  LibraryItem,
  McpServer,
  Memory,
  Route,
  ScreenId,
  Settings,
  Skill,
} from "../types";
import {
  asArray,
  clearStored,
  mergeObject,
  usePersistentState,
} from "../hooks/usePersistentState";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { seedConversations } from "../data/conversations";
import { seedApprovals } from "../data/approvals";
import { seedGoals } from "../data/goals";
import { seedAutomations } from "../data/automations";
import { seedLibrary } from "../data/library";
import { seedConnections, seedMcpServers } from "../data/connections";
import { seedMemories, seedSkills } from "../data/memory";
import { defaultSettings } from "../data/settings";

type Setter<T> = Dispatch<SetStateAction<T>>;

export const SCREENS: ScreenId[] = [
  "overview",
  "chat",
  "approvals",
  "goals",
  "automations",
  "library",
  "connections",
  "capabilities",
  "memory",
  "settings",
  "motion",
];

interface AppContextValue {
  route: Route;
  navigate: (
    screen: ScreenId,
    id?: string,
    opts?: { replace?: boolean },
  ) => void;
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  resolvedTheme: "light" | "dark";
  reducedMotion: boolean;
  conversations: Conversation[];
  setConversations: Setter<Conversation[]>;
  approvals: Approval[];
  setApprovals: Setter<Approval[]>;
  goals: Goal[];
  setGoals: Setter<Goal[]>;
  automations: Automation[];
  setAutomations: Setter<Automation[]>;
  library: LibraryItem[];
  setLibrary: Setter<LibraryItem[]>;
  connections: AppConnection[];
  setConnections: Setter<AppConnection[]>;
  mcpServers: McpServer[];
  setMcpServers: Setter<McpServer[]>;
  memories: Memory[];
  setMemories: Setter<Memory[]>;
  skills: Skill[];
  setSkills: Setter<Skill[]>;
  chatScenario: ChatScenario;
  setChatScenario: Setter<ChatScenario>;
  paletteOpen: boolean;
  setPaletteOpen: Setter<boolean>;
  shortcutsOpen: boolean;
  setShortcutsOpen: Setter<boolean>;
  demoInfoOpen: boolean;
  setDemoInfoOpen: Setter<boolean>;
  announce: (message: string) => void;
  resetDemo: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [screen, id] = raw.split("/");
  if (SCREENS.includes(screen as ScreenId)) {
    try {
      return {
        screen: screen as ScreenId,
        id: id ? decodeURIComponent(id) : undefined,
      };
    } catch {
      return { screen: screen as ScreenId };
    }
  }
  return { screen: "overview" };
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable
  );
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>(() => parseHash());
  const [settings, setSettings] = usePersistentState<Settings>(
    "settings",
    defaultSettings,
    mergeObject,
  );
  const [conversations, setConversations] = usePersistentState<Conversation[]>(
    "conversations",
    seedConversations,
    asArray,
  );
  const [approvals, setApprovals] = usePersistentState<Approval[]>(
    "approvals",
    seedApprovals,
    asArray,
  );
  const [goals, setGoals] = usePersistentState<Goal[]>(
    "goals",
    seedGoals,
    asArray,
  );
  const [automations, setAutomations] = usePersistentState<Automation[]>(
    "automations",
    seedAutomations,
    asArray,
  );
  const [library, setLibrary] = usePersistentState<LibraryItem[]>(
    "library",
    seedLibrary,
    asArray,
  );
  const [connections, setConnections] = usePersistentState<AppConnection[]>(
    "connections",
    seedConnections,
    asArray,
  );
  const [mcpServers, setMcpServers] = usePersistentState<McpServer[]>(
    "mcp",
    seedMcpServers,
    asArray,
  );
  const [memories, setMemories] = usePersistentState<Memory[]>(
    "memories",
    seedMemories,
    asArray,
  );
  const [skills, setSkills] = usePersistentState<Skill[]>(
    "skills",
    seedSkills,
    asArray,
  );
  const [chatScenario, setChatScenario] = useState<ChatScenario>("ready");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [demoInfoOpen, setDemoInfoOpen] = useState(false);
  const [liveMessage, setLiveMessage] = useState("");

  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const systemReduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const resolvedTheme: "light" | "dark" =
    settings.theme === "system"
      ? systemDark
        ? "dark"
        : "light"
      : settings.theme;
  const reducedMotion =
    settings.reduceMotion === "system"
      ? systemReduced
      : settings.reduceMotion === "on";

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
  }, [resolvedTheme]);

  useEffect(() => {
    const onPop = () => setRoute(parseHash());
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onPop);
    };
  }, []);

  const navigate = useCallback(
    (screen: ScreenId, id?: string, opts?: { replace?: boolean }) => {
      const hash = `#/${screen}${id ? `/${encodeURIComponent(id)}` : ""}`;
      try {
        if (window.location.hash !== hash) {
          if (opts?.replace) window.history.replaceState(null, "", hash);
          else window.history.pushState(null, "", hash);
        }
      } catch {
        /* history may be unavailable in sandboxed previews */
      }
      setRoute({ screen, id });
      if (!opts?.replace) window.scrollTo({ top: 0 });
    },
    [],
  );

  const updateSettings = useCallback(
    (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })),
    [setSettings],
  );

  const announce = useCallback((message: string) => {
    setLiveMessage("");
    window.setTimeout(() => setLiveMessage(message), 60);
  }, []);

  const resetDemo = useCallback(() => {
    clearStored();
    setSettings(defaultSettings);
    setConversations(seedConversations);
    setApprovals(seedApprovals);
    setGoals(seedGoals);
    setAutomations(seedAutomations);
    setLibrary(seedLibrary);
    setConnections(seedConnections);
    setMcpServers(seedMcpServers);
    setMemories(seedMemories);
    setSkills(seedSkills);
    setChatScenario("ready");
  }, [
    setSettings,
    setConversations,
    setApprovals,
    setGoals,
    setAutomations,
    setLibrary,
    setConnections,
    setMcpServers,
    setMemories,
    setSkills,
  ]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (
        e.key === "?" &&
        !isTypingTarget(e.target) &&
        !e.metaKey &&
        !e.ctrlKey
      ) {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({
      route,
      navigate,
      settings,
      updateSettings,
      resolvedTheme,
      reducedMotion,
      conversations,
      setConversations,
      approvals,
      setApprovals,
      goals,
      setGoals,
      automations,
      setAutomations,
      library,
      setLibrary,
      connections,
      setConnections,
      mcpServers,
      setMcpServers,
      memories,
      setMemories,
      skills,
      setSkills,
      chatScenario,
      setChatScenario,
      paletteOpen,
      setPaletteOpen,
      shortcutsOpen,
      setShortcutsOpen,
      demoInfoOpen,
      setDemoInfoOpen,
      announce,
      resetDemo,
    }),
    [
      route,
      navigate,
      settings,
      updateSettings,
      resolvedTheme,
      reducedMotion,
      conversations,
      setConversations,
      approvals,
      setApprovals,
      goals,
      setGoals,
      automations,
      setAutomations,
      library,
      setLibrary,
      connections,
      setConnections,
      mcpServers,
      setMcpServers,
      memories,
      setMemories,
      skills,
      setSkills,
      chatScenario,
      paletteOpen,
      shortcutsOpen,
      demoInfoOpen,
      announce,
      resetDemo,
    ],
  );

  return (
    <AppContext.Provider value={value}>
      {children}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {liveMessage}
      </div>
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}
