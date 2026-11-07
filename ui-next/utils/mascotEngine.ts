import type { MascotStateId } from "../types";

/**
 * BLIP mascot geometry + pose engine.
 * Solid black round disk (R = 28% of canvas) with two white round-capped eye strokes.
 * Eye gap .31R, neutral eye length .31R, stroke thickness .25R.
 * All pose offsets are expressed in units of R.
 */

export interface EyePose {
  len: number;
  tilt: number;
  bend: number;
  dx: number;
  dy: number;
}

export interface Pose {
  x: number;
  y: number;
  sx: number;
  sy: number;
  rot: number;
  gx: number;
  gy: number;
  l: EyePose;
  r: EyePose;
  spinner: number;
}

const TAU = Math.PI * 2;
const HALF = Math.PI / 2;

const eye = (o: Partial<EyePose> = {}): EyePose => ({
  len: 1,
  tilt: 0,
  bend: 0,
  dx: 0,
  dy: 0,
  ...o,
});
export const basePose = (): Pose => ({
  x: 0,
  y: 0,
  sx: 1,
  sy: 1,
  rot: 0,
  gx: 0,
  gy: 0,
  l: eye(),
  r: eye(),
  spinner: 0,
});

const smooth = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v));
const bump = (t: number, a: number, b: number) =>
  t < a || t > b ? 0 : Math.sin(((t - a) / (b - a)) * Math.PI);
const plateau = (t: number, a: number, b: number, r = 0.18) =>
  t < a || t > b ? 0 : Math.min(smooth((t - a) / r), smooth((b - t) / r));

function breathe(p: Pose, t: number, period = 3.4, amp = 0.014) {
  const b = Math.sin((t * TAU) / period);
  p.sy *= 1 + amp * b;
  p.sx *= 1 - amp * 0.6 * b;
  p.y -= amp * 0.5 * b;
}

function blink(p: Pose, t: number, period = 4.2, offset = 1.1) {
  const c = (t + offset) % period;
  const k = c < 0.16 ? Math.sin((c / 0.16) * Math.PI) : 0;
  p.l.len *= 1 - 0.82 * k;
  p.r.len *= 1 - 0.82 * k;
}

function setEyes(p: Pose, o: Partial<EyePose>) {
  Object.assign(p.l, o);
  Object.assign(p.r, o);
}

function hop(p: Pose, t: number, start: number, dur: number, h: number) {
  p.y -= h * bump(t, start, start + dur);
  const land = bump(t, start + dur, start + dur + 0.16);
  p.sy *= 1 - 0.05 * land;
  p.sx *= 1 + 0.04 * land;
}

const DARTS: [number, number][] = [
  [-0.15, -0.06],
  [0.15, -0.08],
  [-0.11, 0.07],
  [0.16, 0.05],
  [0.02, -0.11],
];
const KEYSTROKES = [1, 0, 1, 1, 0, 1, 0, 1, 1, 1, 0, 0];

type PoseFn = (t: number) => Pose;

const STATES: Record<MascotStateId, PoseFn> = {
  idle: (t) => {
    const p = basePose();
    const c = t % 7;
    p.gx = 0.12 * plateau(c, 1.6, 2.6) - 0.12 * plateau(c, 4.2, 5.1);
    p.gy = -0.02 * plateau(c, 4.2, 5.1);
    breathe(p, t);
    blink(p, t);
    return p;
  },
  listening: (t) => {
    const p = basePose();
    const c = t % 5;
    p.rot = 0.07;
    p.x = 0.035;
    setEyes(p, { len: 1.08 });
    p.gx = 0.05 + 0.08 * plateau(c, 1.2, 2.2);
    p.gy = -0.03;
    breathe(p, t, 3);
    blink(p, t, 4.6);
    return p;
  },
  reading: (t) => {
    const p = basePose();
    const line = 0.95;
    const c = t % (line * 4 + 0.6);
    setEyes(p, { len: 0.86 });
    if (c < line * 4) {
      const li = Math.floor(c / line);
      const lp = (c % line) / line;
      p.gx =
        lp < 0.82
          ? -0.13 + 0.26 * smooth(lp / 0.82)
          : 0.13 - 0.26 * smooth((lp - 0.82) / 0.18);
      p.gy = -0.06 + li * 0.045;
    } else {
      p.gy = 0.02;
    }
    breathe(p, t, 3.6, 0.008);
    return p;
  },
  writing: (t) => {
    const p = basePose();
    const step = Math.floor(t / 0.17);
    const ph = (t % 0.17) / 0.17;
    const k = KEYSTROKES[step % KEYSTROKES.length] * Math.sin(ph * Math.PI);
    setEyes(p, { len: 0.82 });
    p.gy = 0.09;
    p.gx = -0.06 + 0.12 * ((t % 3) / 3);
    p.y += 0.018 * k;
    p.sy *= 1 - 0.012 * k;
    blink(p, t, 5);
    return p;
  },
  editing: (t) => {
    const p = basePose();
    const c = t % 3.2;
    if (c < 1.2) {
      p.gx = -0.12 * Math.cos((c / 1.2) * Math.PI);
      p.gy = -0.02;
      setEyes(p, { len: 0.9 });
    } else if (c < 1.8) {
      p.gx = 0.1;
      p.gy = 0.05;
      setEyes(p, { len: 0.52 });
    } else if (c < 2.8) {
      p.gx = 0.1;
      p.gy = 0.06;
      setEyes(p, { len: 0.78 });
      const b = Math.sin((((c - 1.8) % 0.2) / 0.2) * Math.PI);
      p.y += 0.016 * b;
      p.sy *= 1 - 0.012 * b;
    } else {
      p.gx = 0.1 * (1 - smooth((c - 2.8) / 0.4));
    }
    return p;
  },
  searching: (t) => {
    const p = basePose();
    const c = t % 3.1;
    if (c < 2.25) {
      const [x, y] = DARTS[Math.min(4, Math.floor(c / 0.45))];
      p.gx = x;
      p.gy = y;
      p.rot = x * 0.25;
    }
    setEyes(p, { len: 0.95 });
    breathe(p, t, 3, 0.008);
    return p;
  },
  running: (t) => {
    const p = basePose();
    const c = t % 1.1;
    const k = bump(c, 0, 0.16) + 0.6 * bump(c, 0.22, 0.36);
    p.sx *= 1 + 0.03 * k;
    p.sy *= 1 + 0.03 * k;
    setEyes(p, { len: 0.8 });
    p.gy = 0.02;
    blink(p, t, 4.8);
    return p;
  },
  approval: (t) => {
    const p = basePose();
    p.gx = 0.13 * plateau(t, 0.15, 0.75);
    setEyes(p, { len: 1.1 });
    hop(p, t, 0.85, 0.36, 0.1);
    if (t > 1.6) {
      breathe(p, t, 3.4, 0.008);
      blink(p, t, 4.4, 0.4);
    }
    return p;
  },
  unsure: (t) => {
    const p = basePose();
    p.rot = -0.1;
    p.l.dy = -0.02;
    Object.assign(p.r, { len: 0.62, tilt: 0.28, dy: 0.05 });
    p.gx = -0.05 + 0.03 * Math.sin(t * 1.3);
    breathe(p, t);
    blink(p, t, 5);
    return p;
  },
  done: (t) => {
    const p = basePose();
    setEyes(p, { len: 0.95, tilt: HALF, bend: -0.16 });
    p.l.dx = -0.04;
    p.r.dx = 0.04;
    p.gy = -0.03;
    hop(p, t, 0.1, 0.32, 0.1);
    hop(p, t, 0.58, 0.28, 0.065);
    if (t > 1.1) breathe(p, t, 3.2, 0.01);
    return p;
  },
  oops: (t) => {
    const p = basePose();
    p.y = 0.04;
    p.sy = 0.97;
    Object.assign(p.l, { len: 0.72, dy: 0.06, tilt: 0.24 });
    Object.assign(p.r, { len: 0.72, dy: 0.06, tilt: -0.24 });
    p.gy = 0.05;
    if (t > 0.45 && t < 1.2) {
      const d = 1 - (t - 0.45) / 0.75;
      p.x += 0.05 * Math.sin((t - 0.45) * 26) * d;
    }
    if (t > 1.3) blink(p, t, 5);
    return p;
  },
  replying: (t) => {
    const p = basePose();
    const c = t % 2.3;
    const i = Math.floor(c / 0.24);
    const k = i < 5 ? Math.sin(((c % 0.24) / 0.24) * Math.PI) : 0;
    p.sy *= 1 + 0.035 * k;
    p.sx *= 1 - 0.015 * k;
    setEyes(p, { len: 1 - 0.14 * k });
    blink(p, t, 4.6, 2.5);
    return p;
  },
  sleeping: (t) => {
    const p = basePose();
    setEyes(p, { len: 0.88, tilt: HALF, bend: 0.11, dy: 0.04 });
    p.l.dx = -0.04;
    p.r.dx = 0.04;
    p.gy = 0.03;
    breathe(p, t, 5, 0.028);
    return p;
  },
  waking: (t) => {
    const p = basePose();
    if (t < 0.3) {
      setEyes(p, { len: 0.1 });
      p.gy = 0.03;
    } else if (t < 0.9) {
      p.l.len = 0.45;
      p.r.len = 0.12;
      p.gx = 0.05;
      p.gy = 0.01;
    } else {
      const k = bump(t, 0.9, 1.25);
      setEyes(p, { len: 1 + 0.25 * k });
      p.sy *= 1 + 0.05 * k;
      p.sx *= 1 - 0.02 * k;
      p.y -= 0.05 * k;
      if (t > 1.5) {
        breathe(p, t);
        blink(p, t);
      }
    }
    return p;
  },
  thinking: (t) => {
    const p = basePose();
    const a = (t * TAU) / 2.6;
    p.gx = 0.1 * Math.cos(a);
    p.gy = -0.05 + 0.06 * Math.sin(a);
    setEyes(p, { len: 0.7 });
    p.rot = 0.03 * Math.sin(a);
    breathe(p, t);
    return p;
  },
  curious: (t) => {
    const p = basePose();
    p.rot = 0.15 + 0.03 * Math.sin(t * 1.6);
    p.x = 0.04;
    p.gx = 0.1;
    p.gy = -0.07;
    p.l.len = 1.12;
    p.r.len = 0.95;
    blink(p, t, 4.8);
    return p;
  },
  alert: (t) => {
    const p = basePose();
    setEyes(p, { len: 1.3 });
    const k = bump(t, 0.05, 0.32);
    p.sy *= 1 + 0.07 * k;
    p.sx *= 1 - 0.03 * k;
    p.y -= 0.06 * k;
    if (t > 1) blink(p, t, 5.2, 0.6);
    return p;
  },
  "deep-focus": (t) => {
    const p = basePose();
    setEyes(p, { len: 0.42 });
    p.gy = 0.04;
    p.gx = 0.02 * Math.sin(t * 0.7);
    p.sy = 0.99;
    return p;
  },
  offline: (t) => {
    const p = basePose();
    p.y = 0.06;
    p.sy = 0.96;
    p.sx = 1.02;
    Object.assign(p.l, { len: 0.5, dy: 0.09, tilt: 0.18 });
    Object.assign(p.r, { len: 0.5, dy: 0.09, tilt: -0.18 });
    p.gy = 0.06;
    breathe(p, t, 6, 0.01);
    return p;
  },
  loading: (t) => {
    const p = basePose();
    p.spinner = 1;
    const a = (t * TAU) / 1.4;
    p.gx = 0.06 * Math.cos(a);
    p.gy = 0.05 * Math.sin(a);
    setEyes(p, { len: 0.7 });
    breathe(p, t);
    return p;
  },
};

/** Representative still moment for reduced motion and static renders. */
export const REST_TIME: Record<MascotStateId, number> = {
  idle: 0.5,
  listening: 0.5,
  reading: 0.3,
  writing: 0.05,
  editing: 1.5,
  searching: 0.2,
  running: 0.6,
  approval: 2,
  unsure: 0.5,
  done: 1.4,
  oops: 1.4,
  replying: 1.5,
  sleeping: 0,
  waking: 2,
  thinking: 0.3,
  curious: 0.5,
  alert: 0.6,
  "deep-focus": 0,
  offline: 0,
  loading: 0.3,
};

export function poseFor(state: MascotStateId, t: number): Pose {
  return (STATES[state] ?? STATES.idle)(Math.max(0, t));
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const POSE_KEYS = ["x", "y", "sx", "sy", "rot", "gx", "gy"] as const;
const EYE_KEYS = ["len", "tilt", "bend", "dx", "dy"] as const;

/** Moves `current` toward `target`. Returns the largest change (for idle detection). */
export function lerpPose(
  current: Pose,
  target: Pose,
  f: number,
  spinnerF = f,
): number {
  let delta = 0;
  for (const k of POSE_KEYS) {
    const nv = lerp(current[k], target[k], f);
    delta = Math.max(delta, Math.abs(nv - current[k]));
    current[k] = nv;
  }
  const sv = lerp(current.spinner, target.spinner, spinnerF);
  delta = Math.max(delta, Math.abs(sv - current.spinner));
  current.spinner = sv;
  for (const side of ["l", "r"] as const) {
    for (const k of EYE_KEYS) {
      const nv = lerp(current[side][k], target[side][k], f);
      delta = Math.max(delta, Math.abs(nv - current[side][k]));
      current[side][k] = nv;
    }
  }
  return delta;
}

export function clonePose(p: Pose): Pose {
  return { ...p, l: { ...p.l }, r: { ...p.r } };
}

export function drawMascot(
  ctx: CanvasRenderingContext2D,
  size: number,
  pose: Pose,
  spinAngle = 0,
  spinnerColor = "rgb(114 120 220)",
  clear = true,
) {
  const R = size * 0.28;
  const cx = size / 2;
  const cy = size / 2;
  if (clear) ctx.clearRect(0, 0, size, size);

  if (pose.spinner > 0.01) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, pose.spinner) * 0.8;
    ctx.strokeStyle = spinnerColor;
    ctx.lineWidth = Math.max(1.5, R * 0.06);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.32, spinAngle, spinAngle + 1.15);
    ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.translate(cx + pose.x * R, cy + pose.y * R);
  ctx.rotate(pose.rot);
  ctx.fillStyle = "#0B0B0D";
  ctx.beginPath();
  ctx.ellipse(0, 0, R * pose.sx, R * pose.sy, 0, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = "#FFFFFF";
  ctx.lineCap = "round";
  ctx.lineWidth = R * 0.25;
  const baseLen = R * 0.31;
  const eyeX = R * 0.28; // half of (gap .31R + stroke .25R)
  const eyes: [EyePose, number][] = [
    [pose.l, -1],
    [pose.r, 1],
  ];
  for (const [e, side] of eyes) {
    const L = Math.max(0.001, baseLen * e.len);
    ctx.save();
    ctx.translate(
      (side * eyeX + (e.dx + pose.gx) * R) * pose.sx,
      (e.dy + pose.gy) * R * pose.sy,
    );
    ctx.rotate(e.tilt);
    ctx.beginPath();
    ctx.moveTo(0, -L / 2);
    ctx.quadraticCurveTo(e.bend * R * 2, 0, 0, L / 2);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

/* ---------- One shared animation ticker for every live mascot ---------- */
type TickFn = (now: number) => void;
const subscribers = new Set<TickFn>();
let rafId = 0;

function loop(now: number) {
  subscribers.forEach((fn) => fn(now));
  rafId =
    subscribers.size > 0 && document.visibilityState === "visible"
      ? requestAnimationFrame(loop)
      : 0;
}

function ensureRunning() {
  if (
    !rafId &&
    subscribers.size > 0 &&
    typeof document !== "undefined" &&
    document.visibilityState === "visible"
  ) {
    rafId = requestAnimationFrame(loop);
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", ensureRunning);
}

export function subscribeTicker(fn: TickFn): () => void {
  subscribers.add(fn);
  ensureRunning();
  return () => {
    subscribers.delete(fn);
  };
}
