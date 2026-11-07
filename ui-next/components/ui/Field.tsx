import React, { ReactNode } from "react";

export const inputCls =
  "w-full h-11 md:h-10 rounded-xl border border-line bg-surface px-3.5 text-sm text-ink placeholder:text-ink-3 transition-[border-color,box-shadow] duration-150 ease-out focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent/15";

export const textareaCls =
  "w-full min-h-[96px] resize-y rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm leading-relaxed text-ink placeholder:text-ink-3 transition-[border-color,box-shadow] duration-150 ease-out focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent/15";

export const selectCls = `${inputCls} appearance-none bg-[length:16px] bg-[right_12px_center] bg-no-repeat pr-9`;

interface FieldProps {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className = "",
}: FieldProps) {
  return (
    <div className={className}>
      <label
        htmlFor={htmlFor}
        className="mb-1.5 block text-[13px] font-medium text-ink"
      >
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1.5 text-[12.5px] text-rose-ink" role="alert">
          {error}
        </p>
      ) : (
        hint && <p className="mt-1.5 text-[12.5px] text-ink-3">{hint}</p>
      )}
    </div>
  );
}
