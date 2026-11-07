import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useApp } from "../../contexts/AppContext";
import { MascotStill } from "../mascot/MascotStill";
import { Button } from "../ui/Button";
import { modKey } from "../../utils/platform";

export function FirstRunNote() {
  const { settings, updateSettings, setPaletteOpen, navigate } = useApp();
  return (
    <AnimatePresence initial={false}>
      {!settings.firstRunDismissed && (
        <motion.aside
          aria-label="Getting started"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
          className="overflow-hidden"
        >
          <div className="flex items-start gap-3 rounded-[20px] border border-line bg-surface px-4 py-3.5 sm:items-center">
            <MascotStill state="curious" size={36} />
            <p className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-ink-2">
              <span className="font-medium text-ink">New here?</span> Everything
              is a live demo with local data. Try{" "}
              <button
                type="button"
                className="font-medium text-ink underline decoration-line-strong underline-offset-4"
                onClick={() => setPaletteOpen(true)}
              >
                {modKey} K
              </button>{" "}
              to jump anywhere, review the{" "}
              <button
                type="button"
                className="font-medium text-ink underline decoration-line-strong underline-offset-4"
                onClick={() => navigate("approvals", "a-promo")}
              >
                pending approval
              </button>
              , or meet Blip’s{" "}
              <button
                type="button"
                className="font-medium text-ink underline decoration-line-strong underline-offset-4"
                onClick={() => navigate("motion")}
              >
                20 moods
              </button>
              .
            </p>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Dismiss getting started tips"
              onClick={() => updateSettings({ firstRunDismissed: true })}
            >
              <X />
            </Button>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
