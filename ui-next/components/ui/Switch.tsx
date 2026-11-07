import React from "react";
import { motion } from "framer-motion";

interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
}: SwitchProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors duration-150 ease-out before:absolute before:-inset-2.5 before:content-[''] disabled:opacity-45 ${
        checked ? "bg-accent" : "bg-ink/15"
      }`}
    >
      <motion.span
        layout
        transition={{ type: "spring", stiffness: 700, damping: 40 }}
        className="h-5 w-5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.2)]"
        style={{ marginLeft: checked ? 18 : 2 }}
      />
    </button>
  );
}
