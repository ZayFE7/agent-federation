import React from "react";
import type { SyncState } from "../../types";
import { Badge } from "../ui/Badge";

const MAP: Record<
  SyncState,
  { tone: "healthy" | "accent" | "attention" | "danger"; label: string }
> = {
  synced: { tone: "healthy", label: "Synced" },
  syncing: { tone: "accent", label: "Syncing" },
  expired: { tone: "attention", label: "Authorization expired" },
  error: { tone: "danger", label: "Sync error" },
};

export function AccountState({ state }: { state: SyncState }) {
  const s = MAP[state];
  return (
    <Badge tone={s.tone} dot pulse={state === "syncing"}>
      {s.label}
    </Badge>
  );
}
