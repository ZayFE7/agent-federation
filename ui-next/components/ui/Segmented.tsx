import React, { KeyboardEvent, ReactNode, useId } from "react";
import { motion } from "framer-motion";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  count?: number;
  srLabel?: string;
}

interface SegmentedProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: "sm" | "md";
  className?: string;
  scroll?: boolean;
}

/** Accessible radio-group style segmented control with arrow-key support. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = "md",
  className = "",
  scroll,
}: SegmentedProps<T>) {
  const groupId = useId();
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowRight", "ArrowLeft"].includes(e.key)) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const next =
      options[
        (i + (e.key === "ArrowRight" ? 1 : -1) + options.length) %
          options.length
      ];
    onChange(next.value);
    const btn = e.currentTarget.querySelector(
      `[data-value="${next.value}"]`,
    ) as HTMLButtonElement | null;
    btn?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKey}
      className={`inline-flex items-center gap-0.5 rounded-xl bg-ink/[0.05] p-1 ${scroll ? "max-w-full overflow-x-auto scroll-thin" : ""} ${className}`}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={o.srLabel}
            data-value={o.value}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] font-medium transition-colors duration-150 [&_svg]:h-4 [&_svg]:w-4 ${
              size === "sm"
                ? "min-h-[40px] md:min-h-0 md:h-7 px-2.5 text-[12.5px]"
                : "min-h-[40px] md:min-h-0 md:h-8 px-3 text-[13px]"
            } ${active ? "text-ink" : "text-ink-2 hover:text-ink"}`}
          >
            {active && (
              <motion.span
                layoutId={`seg-${groupId}`}
                className="absolute inset-0 rounded-[9px] bg-surface shadow-soft"
                transition={{ type: "spring", stiffness: 520, damping: 42 }}
              />
            )}
            <span className="relative inline-flex items-center gap-1.5">
              {o.icon}
              {o.label}
              {typeof o.count === "number" && (
                <span className="tabular text-ink-3">{o.count}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
