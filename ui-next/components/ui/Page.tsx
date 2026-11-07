import React, { ReactNode } from "react";

export function Page({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`mx-auto w-full max-w-[1220px] px-5 py-8 md:px-8 md:py-10 lg:px-10 ${className}`}
    >
      {children}
    </div>
  );
}

interface PageHeaderProps {
  index: string;
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({
  index,
  eyebrow,
  title,
  description,
  actions,
}: PageHeaderProps) {
  return (
    <header className="flex flex-col gap-5 pb-8 md:flex-row md:items-end md:justify-between md:pb-10">
      <div className="max-w-2xl">
        <p className="font-mono text-[11px] tracking-[0.06em] text-ink-3">
          <span className="text-accent-ink">{index}</span> · {eyebrow}
        </p>
        <h1 className="mt-3 text-[34px] font-semibold leading-[1.02] tracking-[-0.03em] md:text-[46px]">
          {title}
        </h1>
        {description && (
          <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-ink-2">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function SectionTitle({
  children,
  action,
  id,
}: {
  children: ReactNode;
  action?: ReactNode;
  id?: string;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 id={id} className="text-[15px] font-semibold tracking-[-0.01em]">
        {children}
      </h2>
      {action}
    </div>
  );
}
