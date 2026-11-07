import React, { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  body,
  action,
  className = "",
}: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center px-6 py-14 text-center ${className}`}
    >
      {icon && (
        <div className="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-ink/[0.05] text-ink-2 [&_svg]:h-5 [&_svg]:w-5">
          {icon}
        </div>
      )}
      <h3 className="text-[15px] font-semibold">{title}</h3>
      {body && (
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-ink-2">
          {body}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`rounded-lg bg-ink/[0.06] motion-safe:animate-pulse ${className}`}
      aria-hidden
    />
  );
}
