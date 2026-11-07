import type { Settings } from "../types";

export const MODELS = [
  { id: "balanced", label: "Balanced", note: "Default — good for most tasks" },
  {
    id: "deep",
    label: "Deep reasoning",
    note: "Slower, more careful planning",
  },
  { id: "quick", label: "Quick", note: "Fast drafts and short replies" },
];

export const defaultSettings: Settings = {
  name: "Maya",
  timezone: "America/Los_Angeles",
  theme: "light",
  reduceMotion: "system",
  mascotAnimated: true,
  model: "balanced",
  providers: [
    {
      id: "prov-local",
      name: "Local sandbox (demo)",
      baseUrl: "http://localhost:11434/v1",
      models: ["blip-local-small"],
    },
  ],
  firstRunDismissed: false,
};

export const SHORTCUTS = [
  { keys: ["⌘/Ctrl", "K"], label: "Open command palette" },
  { keys: ["?"], label: "Show keyboard shortcuts" },
  { keys: ["/"], label: "Focus the chat composer (in Conversations)" },
  { keys: ["Enter"], label: "Send message" },
  { keys: ["Shift", "Enter"], label: "New line in composer" },
  { keys: ["↑", "↓"], label: "Move through palette results" },
  { keys: ["Esc"], label: "Close dialog, sheet or palette" },
];
