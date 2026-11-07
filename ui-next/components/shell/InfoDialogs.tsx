import React from "react";
import { HardDrive, PlugZap, ShieldCheck, Sparkles } from "lucide-react";
import { useApp } from "../../contexts/AppContext";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { SHORTCUTS } from "../../data/settings";
import { modKey } from "../../utils/platform";

export function ShortcutsDialog() {
  const { shortcutsOpen, setShortcutsOpen } = useApp();
  return (
    <Dialog
      open={shortcutsOpen}
      onClose={() => setShortcutsOpen(false)}
      title="Keyboard shortcuts"
      size="sm"
    >
      <dl className="divide-y divide-line">
        {SHORTCUTS.map((s) => (
          <div
            key={s.label}
            className="flex items-center justify-between gap-4 py-3"
          >
            <dt className="text-[14px] text-ink-2">{s.label}</dt>
            <dd className="flex shrink-0 gap-1">
              {s.keys.map((k) => (
                <kbd
                  key={k}
                  className="min-w-[28px] rounded-md border border-line bg-sunken px-1.5 py-1 text-center font-mono text-[11.5px] text-ink"
                >
                  {k === "⌘/Ctrl" ? modKey : k}
                </kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}

const POINTS = [
  {
    icon: HardDrive,
    title: "Everything stays in this browser",
    body: "Chats, goals, files and settings are saved to local storage on this device only.",
  },
  {
    icon: Sparkles,
    title: "Agent runs are simulated",
    body: "Runs follow a deterministic script — planning, searching, tools, approval. No AI model is called.",
  },
  {
    icon: PlugZap,
    title: "Integrations are demo data",
    body: "Gmail, Calendar, GitHub and MCP servers are mock data. No real sign-in happens and no tokens are requested or stored.",
  },
  {
    icon: ShieldCheck,
    title: "Approvals produce demo receipts",
    body: "Approving an action records a receipt. Nothing is sent, moved or deleted anywhere.",
  },
];

export function DemoInfoDialog() {
  const { demoInfoOpen, setDemoInfoOpen, navigate } = useApp();
  return (
    <Dialog
      open={demoInfoOpen}
      onClose={() => setDemoInfoOpen(false)}
      eyebrow="interactive demo"
      title="What’s real here, and what isn’t"
      size="sm"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              setDemoInfoOpen(false);
              navigate("settings", "data");
            }}
          >
            Reset demo data
          </Button>
          <Button variant="primary" onClick={() => setDemoInfoOpen(false)}>
            Got it
          </Button>
        </>
      }
    >
      <ul className="space-y-4">
        {POINTS.map((p) => (
          <li key={p.title} className="flex gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-ink">
              <p.icon className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <p className="text-[14px] font-medium">{p.title}</p>
              <p className="mt-0.5 text-[13.5px] leading-relaxed text-ink-2">
                {p.body}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
