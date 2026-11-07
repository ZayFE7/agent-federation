import React, { ReactNode } from "react";
import { motion } from "framer-motion";
import type { MascotStateId } from "../../types";
import { Mascot } from "./Mascot";
import { useApp } from "../../contexts/AppContext";

interface MascotStageProps {
  state: MascotStateId;
  size?: number;
  chip?: ReactNode;
  className?: string;
  paused?: boolean;
  speed?: number;
  reducedMotion?: boolean;
  replayKey?: number;
}

/** Pale-lilac orbital stage. Ornament is restrained: two hairline orbits, two slow satellites. */
export function MascotStage({
  state,
  size = 320,
  chip,
  className = "",
  paused,
  speed,
  reducedMotion,
  replayKey,
}: MascotStageProps) {
  const { reducedMotion: appReduced, settings } = useApp();
  const still = reducedMotion ?? (appReduced || !settings.mascotAnimated);
  return (
    <div
      className={`relative isolate aspect-square w-full overflow-hidden rounded-[28px] border border-line bg-stage ${className}`}
    >
      <svg
        viewBox="0 0 400 400"
        className="absolute inset-0 h-full w-full"
        aria-hidden
      >
        <circle
          cx="200"
          cy="200"
          r="120"
          fill="none"
          stroke="rgb(var(--accent) / 0.18)"
          strokeWidth="1"
        />
        <circle
          cx="200"
          cy="200"
          r="165"
          fill="none"
          stroke="rgb(var(--accent) / 0.22)"
          strokeWidth="1"
          strokeDasharray="2 7"
        />
        <circle
          cx="200"
          cy="200"
          r="196"
          fill="none"
          stroke="rgb(var(--accent) / 0.1)"
          strokeWidth="1"
        />
      </svg>
      <motion.div
        aria-hidden
        className="absolute inset-0"
        animate={still || paused ? undefined : { rotate: 360 }}
        transition={{ duration: 60, repeat: Infinity, ease: "linear" }}
      >
        <span className="absolute left-1/2 top-[8.75%] h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/70" />
      </motion.div>
      <motion.div
        aria-hidden
        className="absolute inset-0"
        animate={still || paused ? undefined : { rotate: -360 }}
        transition={{ duration: 42, repeat: Infinity, ease: "linear" }}
      >
        <span className="absolute left-[80%] top-[50%] h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sage/70" />
      </motion.div>
      <div className="absolute inset-0 grid place-items-center">
        <Mascot
          state={state}
          size={size}
          paused={paused}
          speed={speed}
          reducedMotion={reducedMotion}
          replayKey={replayKey}
        />
      </div>
      {chip && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2">
          {chip}
        </div>
      )}
    </div>
  );
}
