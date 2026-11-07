import React from "react";
import {
  Box,
  CalendarDays,
  GitBranch,
  HardDrive,
  Hash,
  ListTodo,
  Mail,
  PenTool,
} from "lucide-react";
import type { AppIconKey } from "../../types";

const MAP: Record<AppIconKey, { Icon: typeof Mail; cls: string }> = {
  gmail: { Icon: Mail, cls: "bg-rose-soft text-rose-ink" },
  calendar: { Icon: CalendarDays, cls: "bg-accent-soft text-accent-ink" },
  tasks: { Icon: ListTodo, cls: "bg-sage-soft text-sage-ink" },
  github: { Icon: GitBranch, cls: "bg-ink text-canvas" },
  slack: { Icon: Hash, cls: "bg-amber-soft text-amber-ink" },
  drive: { Icon: HardDrive, cls: "bg-sage-soft text-sage-ink" },
  dropbox: { Icon: Box, cls: "bg-accent-soft text-accent-ink" },
  figma: { Icon: PenTool, cls: "bg-rose-soft text-rose-ink" },
};

export function AppIcon({
  icon,
  size = "md",
}: {
  icon: AppIconKey;
  size?: "sm" | "md" | "lg";
}) {
  const { Icon, cls } = MAP[icon];
  const dims =
    size === "sm"
      ? "h-8 w-8 rounded-[10px] [&_svg]:h-4 [&_svg]:w-4"
      : size === "lg"
        ? "h-12 w-12 rounded-2xl [&_svg]:h-6 [&_svg]:w-6"
        : "h-10 w-10 rounded-xl [&_svg]:h-5 [&_svg]:w-5";
  return (
    <span
      className={`grid shrink-0 place-items-center ${dims} ${cls}`}
      aria-hidden
    >
      <Icon />
    </span>
  );
}
