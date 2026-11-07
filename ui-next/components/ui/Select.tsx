import React, { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { inputCls } from "./Field";

interface SelectProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  ariaLabel?: string;
  className?: string;
  compact?: boolean;
}

export function Select({
  id,
  value,
  onChange,
  children,
  ariaLabel,
  className = "",
  compact,
}: SelectProps) {
  return (
    <div className={`relative ${className}`}>
      <select
        id={id}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputCls} cursor-pointer appearance-none pr-9 ${compact ? "md:h-8 text-[13px]" : ""}`}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3"
        aria-hidden
      />
    </div>
  );
}
