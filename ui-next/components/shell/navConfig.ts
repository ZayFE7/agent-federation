import {
  Activity,
  Brain,
  FolderOpen,
  Inbox,
  LayoutDashboard,
  LucideIcon,
  MessageSquare,
  Plug,
  Puzzle,
  Repeat,
  Settings,
  Target,
} from "lucide-react";
import type { ScreenId } from "../../types";

export interface NavItem {
  id: ScreenId;
  label: string;
  short: string;
  icon: LucideIcon;
  index: string;
  description: string;
}

export const NAV_ITEMS: Record<ScreenId, NavItem> = {
  overview: {
    id: "overview",
    label: "Overview",
    short: "Overview",
    icon: LayoutDashboard,
    index: "01",
    description: "Your day at a glance",
  },
  chat: {
    id: "chat",
    label: "Conversations",
    short: "Chat",
    icon: MessageSquare,
    index: "02",
    description: "Talk to Blip and watch runs",
  },
  approvals: {
    id: "approvals",
    label: "Approvals",
    short: "Approvals",
    icon: Inbox,
    index: "03",
    description: "Exact actions waiting on you",
  },
  goals: {
    id: "goals",
    label: "Goals",
    short: "Goals",
    icon: Target,
    index: "04",
    description: "Longer work with success criteria",
  },
  automations: {
    id: "automations",
    label: "Automations",
    short: "Routines",
    icon: Repeat,
    index: "05",
    description: "Schedules, watchers and webhooks",
  },
  library: {
    id: "library",
    label: "Library",
    short: "Library",
    icon: FolderOpen,
    index: "06",
    description: "Files and everything Blip made",
  },
  connections: {
    id: "connections",
    label: "Connections",
    short: "Apps",
    icon: Plug,
    index: "07",
    description: "Apps, accounts and MCP servers",
  },
  capabilities: {
    id: "capabilities",
    label: "Capabilities",
    short: "Abilities",
    icon: Puzzle,
    index: "08",
    description: "What Blip can do, and its limits",
  },
  memory: {
    id: "memory",
    label: "Memory & skills",
    short: "Memory",
    icon: Brain,
    index: "09",
    description: "What Blip remembers and knows how to do",
  },
  settings: {
    id: "settings",
    label: "Settings",
    short: "Settings",
    icon: Settings,
    index: "10",
    description: "Appearance, models, safety, data",
  },
  motion: {
    id: "motion",
    label: "Motion lab",
    short: "Motion",
    icon: Activity,
    index: "11",
    description: "All 20 mascot states",
  },
};

export const NAV_GROUPS: { label?: string; items: ScreenId[] }[] = [
  {
    items: ["overview", "chat", "approvals", "goals", "automations", "library"],
  },
  { label: "Agent", items: ["connections", "capabilities", "memory"] },
  { label: "Studio", items: ["motion", "settings"] },
];

export const MOBILE_PRIMARY: ScreenId[] = [
  "overview",
  "chat",
  "goals",
  "library",
];
