import React from "react";
import type { GoalStatus, Tone } from "../../types";
import { Badge } from "../ui/Badge";

export const GOAL_STATUS: Record<
  GoalStatus,
  { label: string; tone: Tone; bar: "accent" | "healthy" | "attention" | "ink" }
> = {
  "in-progress": { label: "In progress", tone: "accent", bar: "accent" },
  "needs-you": { label: "Needs you", tone: "attention", bar: "attention" },
  complete: { label: "Complete", tone: "healthy", bar: "healthy" },
  paused: { label: "Paused", tone: "neutral", bar: "ink" },
  cancelled: { label: "Cancelled", tone: "muted", bar: "ink" },
};

export function GoalStatusBadge({ status }: { status: GoalStatus }) {
  const s = GOAL_STATUS[status];
  return (
    <Badge tone={s.tone} dot pulse={status === "in-progress"}>
      {s.label}
    </Badge>
  );
}
