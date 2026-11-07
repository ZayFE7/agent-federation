import type { MascotStateId } from "../types";

export interface MascotStateInfo {
  id: MascotStateId;
  label: string;
  note: string;
  group: "Rest" | "Attention" | "Work" | "Outcome";
}

export const MASCOT_STATES: MascotStateInfo[] = [
  {
    id: "idle",
    label: "Idle",
    group: "Rest",
    note: "Slow breath with two small glances. The default when nothing is happening.",
  },
  {
    id: "sleeping",
    label: "Sleeping",
    group: "Rest",
    note: "Closed, downward-curved eyes and a slower, deeper breath.",
  },
  {
    id: "waking",
    label: "Waking",
    group: "Rest",
    note: "One eye peeks open, then both snap awake and settle into idle.",
  },
  {
    id: "loading",
    label: "Loading",
    group: "Rest",
    note: "A thin spinner arc circles; it fades softly instead of vanishing.",
  },
  {
    id: "offline",
    label: "Offline",
    group: "Rest",
    note: "Low, droopy eyes and a slight sag. Used when the connection drops.",
  },
  {
    id: "listening",
    label: "Listening",
    group: "Attention",
    note: "Leans in with taller eyes and glances toward you while you type.",
  },
  {
    id: "curious",
    label: "Curious",
    group: "Attention",
    note: "Tilts and leans, one eye a little taller than the other.",
  },
  {
    id: "alert",
    label: "Alert",
    group: "Attention",
    note: "Eyes open wide with one small pop, then hold.",
  },
  {
    id: "approval",
    label: "Approval",
    group: "Attention",
    note: "Glances at the action, one small hop, then holds still for your call.",
  },
  {
    id: "unsure",
    label: "Unsure",
    group: "Attention",
    note: "Asymmetric eyes and a head tilt — Blip needs clarification.",
  },
  {
    id: "thinking",
    label: "Thinking",
    group: "Work",
    note: "Shorter eyes orbit slowly while a plan forms.",
  },
  {
    id: "searching",
    label: "Searching",
    group: "Work",
    note: "Five quick gaze darts across sources, then a short rest.",
  },
  {
    id: "reading",
    label: "Reading",
    group: "Work",
    note: "Eyes scan left to right, stepping down line by line.",
  },
  {
    id: "writing",
    label: "Writing",
    group: "Work",
    note: "Eyes look down; tiny keystroke bounces in an irregular rhythm.",
  },
  {
    id: "editing",
    label: "Editing",
    group: "Work",
    note: "Scan, spot (eyes narrow), then quick patch taps.",
  },
  {
    id: "running",
    label: "Running",
    group: "Work",
    note: "Focused eyes with a soft double heartbeat while tools run.",
  },
  {
    id: "deep-focus",
    label: "Deep focus",
    group: "Work",
    note: "Narrow eyes, breath held. Long, uninterrupted work.",
  },
  {
    id: "replying",
    label: "Replying",
    group: "Outcome",
    note: "Five speech pulses, then a pause — writing back to you.",
  },
  {
    id: "done",
    label: "Done",
    group: "Outcome",
    note: "Happy curved eyes, two small hops, then settles.",
  },
  {
    id: "oops",
    label: "Oops",
    group: "Outcome",
    note: "Eyes droop, one gentle shake, then settles. Something failed.",
  },
];

export const MOTION_SEQUENCE: MascotStateId[] = [
  "idle",
  "listening",
  "thinking",
  "searching",
  "writing",
  "approval",
  "done",
  "idle",
];

export function mascotLabel(id: MascotStateId): string {
  return MASCOT_STATES.find((s) => s.id === id)?.label ?? id;
}
