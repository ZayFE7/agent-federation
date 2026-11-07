import React, { ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { Button } from "./Button";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  variant?: "center" | "side";
  bodyClassName?: string;
}

const widths = {
  sm: "max-w-[440px]",
  md: "max-w-[560px]",
  lg: "max-w-[760px]",
};

/** True modal dialog. Centered on desktop, side sheet when `variant="side"`, bottom sheet on phones. */
export function Dialog(props: DialogProps) {
  const [mounted, setMounted] = useState(props.open);
  useEffect(() => {
    if (props.open) {
      setMounted(true);
      return;
    }
    const delay =
      document.documentElement.dataset.motion === "reduced" ? 0 : 200;
    const timer = window.setTimeout(() => setMounted(false), delay);
    return () => window.clearTimeout(timer);
  }, [props.open]);
  if (typeof document === "undefined") return null;
  return createPortal(
    mounted ? <DialogPanel {...props} /> : null,
    document.body,
  );
}

function DialogPanel({
  open,
  onClose,
  title,
  description,
  eyebrow,
  children,
  footer,
  size = "md",
  variant = "center",
  bodyClassName = "",
}: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, open);
  const isMobile = useMediaQuery("(max-width: 639px)");
  const titleId = useId();
  const descId = useId();
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (
        event.key === "Escape" &&
        dialogs[dialogs.length - 1] === ref.current
      ) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open, onClose]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const side = variant === "side" && !isMobile;
  const motionProps = isMobile
    ? { initial: { y: "100%" }, animate: { y: 0 }, exit: { y: "100%" } }
    : side
      ? {
          initial: { x: 56, opacity: 0 },
          animate: { x: 0, opacity: 1 },
          exit: { x: 56, opacity: 0 },
        }
      : {
          initial: { y: 10, scale: 0.98, opacity: 0 },
          animate: { y: 0, scale: 1, opacity: 1 },
          exit: { y: 6, scale: 0.985, opacity: 0 },
        };
  const container = isMobile
    ? "items-end"
    : side
      ? "justify-end"
      : "items-center justify-center p-6";
  const panel = isMobile
    ? "w-full max-h-[92dvh] rounded-t-[22px]"
    : side
      ? `h-full w-full ${size === "lg" ? "max-w-[720px]" : "max-w-[540px]"} rounded-l-[20px] border-r-0`
      : `w-full ${widths[size]} max-h-[88vh] rounded-[20px]`;

  return (
    <div
      className={`fixed inset-0 z-50 flex ${container}`}
      style={{ pointerEvents: open ? "auto" : "none" }}
    >
      <motion.div
        aria-hidden
        className="absolute inset-0 bg-[#141418]/35"
        initial={{ opacity: 0 }}
        animate={{ opacity: open ? 1 : 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
        onClick={onClose}
      />
      <motion.div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
        className={`relative flex flex-col border border-line bg-surface shadow-pop outline-none ${panel}`}
        {...motionProps}
        animate={open ? motionProps.animate : motionProps.exit}
        transition={{ type: "spring", stiffness: 420, damping: 40, mass: 0.9 }}
      >
        {isMobile && (
          <div
            className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-line-strong"
            aria-hidden
          />
        )}
        <div className="flex shrink-0 items-start gap-4 border-b border-line px-5 pb-4 pt-4 sm:px-6 sm:pt-5">
          <div className="min-w-0 flex-1">
            {eyebrow && (
              <div className="mb-1.5 font-mono text-[11px] tracking-[0.04em] text-ink-3">
                {eyebrow}
              </div>
            )}
            <h2
              id={titleId}
              className="text-[18px] font-semibold leading-snug tracking-[-0.01em]"
            >
              {title}
            </h2>
            {description && (
              <p
                id={descId}
                className="mt-1 text-sm leading-relaxed text-ink-2"
              >
                {description}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            onClick={onClose}
            className="-mr-2 -mt-1"
          >
            <X />
          </Button>
        </div>
        <div
          className={`flex-1 overflow-y-auto px-5 py-5 scroll-thin sm:px-6 ${bodyClassName}`}
        >
          {children}
        </div>
        {footer && (
          <div className="safe-bottom flex shrink-0 flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:items-center sm:justify-end sm:px-6">
            {footer}
          </div>
        )}
      </motion.div>
    </div>
  );
}
