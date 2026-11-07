import React, { useEffect, useRef } from "react";
import type { MascotStateId } from "../../types";
import { drawMascot, poseFor, REST_TIME } from "../../utils/mascotEngine";

interface MascotStillProps {
  state?: MascotStateId;
  size: number;
  className?: string;
  label?: string;
}

/** A single static frame from the shared mascot engine — no animation loop. */
export function MascotStill({
  state = "idle",
  size,
  className = "",
  label,
}: MascotStillProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawMascot(ctx, size, poseFor(state, REST_TIME[state]), 0.6);
  }, [state, size]);
  return (
    <canvas
      ref={ref}
      className={className}
      style={{ width: size, height: size }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
