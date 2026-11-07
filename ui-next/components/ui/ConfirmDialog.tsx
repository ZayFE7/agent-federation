import React, { ReactNode, useEffect, useId, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Dialog } from "./Dialog";
import { Button } from "./Button";
import { inputCls } from "./Field";

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: ReactNode;
  impact?: string[];
  confirmLabel: string;
  confirmWord?: string;
  tone?: "danger" | "default";
  children?: ReactNode;
}

/** Guarded confirmation: lists the concrete impact and optionally requires typing a word. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  impact,
  confirmLabel,
  confirmWord,
  tone = "danger",
  children,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const inputId = useId();
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);
  const ready = !confirmWord || typed === confirmWord;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={onClose}
            data-autofocus={confirmWord ? undefined : true}
          >
            Cancel
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            disabled={!ready}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {impact && impact.length > 0 && (
        <div
          className={`rounded-2xl p-4 ${tone === "danger" ? "bg-rose-soft" : "bg-ink/[0.04]"}`}
        >
          <p
            className={`flex items-center gap-2 text-[13px] font-semibold ${tone === "danger" ? "text-rose-ink" : "text-ink"}`}
          >
            <TriangleAlert className="h-4 w-4" aria-hidden /> What this changes
          </p>
          <ul className="mt-2 space-y-1.5 text-[13.5px] text-ink">
            {impact.map((line) => (
              <li key={line} className="flex gap-2">
                <span
                  className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-current opacity-60"
                  aria-hidden
                />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {children}
      {confirmWord && (
        <div className="mt-5">
          <label htmlFor={inputId} className="text-[13px] text-ink-2">
            Type{" "}
            <span className="font-mono font-medium text-ink">
              {confirmWord}
            </span>{" "}
            to confirm
          </label>
          <input
            id={inputId}
            data-autofocus
            className={`${inputCls} mt-2 font-mono`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "Enter" && ready) {
                onConfirm();
                onClose();
              }
            }}
          />
        </div>
      )}
    </Dialog>
  );
}
