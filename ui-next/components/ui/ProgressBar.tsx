import React from "react";
import { motion } from "framer-motion";

interface ProgressBarProps {
  value: number;
  tone?: "accent" | "healthy" | "attention" | "danger" | "ink";
  label: string;
  className?: string;
}

const fills = {
  accent: "bg-accent",
  healthy: "bg-sage",
  attention: "bg-amber",
  danger: "bg-rose",
  ink: "bg-ink",
};

export function ProgressBar({
  value,
  tone = "accent",
  label,
  className = "",
}: ProgressBarProps) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(v)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={`h-1.5 w-full overflow-hidden rounded-full bg-ink/[0.07] ${className}`}
    >
      <motion.div
        className={`h-full rounded-full ${fills[tone]}`}
        initial={false}
        animate={{ width: `${v}%` }}
        transition={{ type: "spring", stiffness: 160, damping: 26 }}
      />
    </div>
  );
}
