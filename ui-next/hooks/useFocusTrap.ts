import { RefObject, useEffect } from "react";

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),iframe,[tabindex]:not([tabindex="-1"])';

/** Traps Tab focus within `ref` while active and restores focus to the opener on close. */
export function useFocusTrap(
  ref: RefObject<HTMLElement>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (!el) return;

    const list = () =>
      Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (n) => n.getClientRects().length > 0,
      );

    const timer = window.setTimeout(() => {
      const preferred = el.querySelector<HTMLElement>("[data-autofocus]");
      (preferred ?? list()[0] ?? el).focus();
    }, 40);

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = list();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    el.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      el.removeEventListener("keydown", onKey);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [active, ref]);
}
