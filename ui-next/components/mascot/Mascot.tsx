import React, { useEffect, useRef } from "react";
import type { MascotStateId } from "../../types";
import { mountMascot, type MascotController } from "../../utils/mascot-runtime";
import { useApp } from "../../contexts/AppContext";
import { mascotLabel } from "../../data/mascotStates";
interface MascotProps {
  state: MascotStateId;
  size: number;
  paused?: boolean;
  speed?: number;
  reducedMotion?: boolean;
  replayKey?: number;
  className?: string;
  label?: string;
  decorative?: boolean;
}
/** Exact original BLIP poses, with continuous transitions, shared visible-only scheduling, and reduced motion. */
export function Mascot({
  state,
  size,
  paused = false,
  speed = 1,
  reducedMotion,
  replayKey = 0,
  className = "",
  label,
  decorative,
}: MascotProps) {
  const { reducedMotion: appReduced, settings } = useApp();
  const reduced = reducedMotion ?? (appReduced || !settings.mascotAnimated);
  const canvas = useRef<HTMLCanvasElement>(null);
  const controller = useRef<MascotController | null>(null);
  const current = useRef({ state, paused, speed, reducedMotion: reduced });
  current.current = { state, paused, speed, reducedMotion: reduced };
  useEffect(() => {
    if (!canvas.current) return;
    controller.current = mountMascot(canvas.current, current.current);
    return () => {
      controller.current?.destroy();
      controller.current = null;
    };
  }, [size]);
  useEffect(() => {
    controller.current?.configure({
      state,
      paused,
      speed,
      reducedMotion: reduced,
    });
  }, [state, paused, speed, reduced]);
  useEffect(() => {
    if (replayKey) controller.current?.replay();
  }, [replayKey]);
  return (
    <canvas
      ref={canvas}
      width={size * 2}
      height={size * 2}
      className={className}
      style={{
        width: size,
        height: "auto",
        maxWidth: "100%",
        aspectRatio: "1 / 1",
      }}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative || undefined}
      aria-label={
        decorative ? undefined : (label ?? `Blip — ${mascotLabel(state)}`)
      }
    />
  );
}
