import React, { ReactNode } from "react";
import type { Tone } from "../../types";

const tones: Record<Tone, string> = {
  neutral: "bg-ink/[0.06] text-ink-2",
  accent: "bg-accent-soft text-accent-ink",
  healthy: "bg-sage-soft text-sage-ink",
  attention: "bg-amber-soft text-amber-ink",
  danger: "bg-rose-soft text-rose-ink",
  muted: "border border-line text-ink-3",
};

const dots: Record<Tone, string> = {
  neutral: "bg-ink-3",
  accent: "bg-accent",
  healthy: "bg-sage",
  attention: "bg-amber",
  danger: "bg-rose",
  muted: "bg-ink-3",
};

interface BadgeProps {
  tone?: Tone;
  dot?: boolean;
  pulse?: boolean;
  children: ReactNode;
  className?: string;
  icon?: ReactNode;
}

export function Badge({
  tone = "neutral",
  dot,
  pulse,
  children,
  className = "",
  icon,
}: BadgeProps) {
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12px] font-medium [&_svg]:h-3.5 [&_svg]:w-3.5 ${tones[tone]} ${className}`}
    >
      {dot && (
        <span className="relative flex h-1.5 w-1.5" aria-hidden>
          {pulse && (
            <span
              className={`absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping ${dots[tone]}`}
            />
          )}
          <span className={`relative h-1.5 w-1.5 rounded-full ${dots[tone]}`} />
        </span>
      )}
      {icon}
      {children}
    </span>
  );
}
