import {
  STATES,
  BASE_KEYS,
  resetPose,
  poseFor,
  resolveState,
  drawMascot,
  type MascotPose,
  type MascotState,
} from "./mascot-poses.js";
export { STATES };
export type MascotStateId =
  | "listening"
  | "reading"
  | "writing"
  | "editing"
  | "searching"
  | "running"
  | "approval"
  | "unsure"
  | "done"
  | "oops"
  | "replying"
  | "sleeping"
  | "idle"
  | "waking"
  | "thinking"
  | "curious"
  | "alert"
  | "deep-focus"
  | "offline"
  | "loading";
export interface MascotOptions {
  state?: string;
  paused?: boolean;
  speed?: number;
  reducedMotion?: boolean;
  onComplete?: () => void;
}
export interface MascotController {
  setState(state: string): void;
  configure(options: Partial<MascotOptions>): void;
  replay(): void;
  destroy(): void;
}
type Instance = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  state: MascotState;
  options: MascotOptions;
  time: number;
  transition: number;
  from: MascotPose;
  pose: MascotPose;
  target: MascotPose;
  visible: boolean;
  width: number;
  height: number;
  dpr: number;
  dirty: boolean;
  finished: boolean;
  doneNotified: boolean;
  io?: IntersectionObserver;
  ro?: ResizeObserver;
};
const instances = new Set<Instance>();
let raf = 0,
  previous = 0;
let media: MediaQueryList | undefined;
let hooked = false;
const makePose = (): MascotPose => {
  const o: MascotPose = {};
  resetPose(o);
  return o;
};
const duration = (s: MascotState) => (s.id === "waking" ? 3.8 : s.duration);
const reduced = (i: Instance) =>
  i.options.reducedMotion ?? media?.matches ?? false;
const moving = (i: Instance) =>
  i.visible &&
  !i.options.paused &&
  !reduced(i) &&
  (!i.finished || i.transition < 0.38);
function wake() {
  if (!raf && !document.hidden) {
    previous = 0;
    raf = requestAnimationFrame(tick);
  }
}
function hook() {
  if (hooked) return;
  hooked = true;
  media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", () => {
    for (const i of instances) i.dirty = true;
    wake();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
      previous = 0;
    } else {
      for (const i of instances) i.dirty = true;
      wake();
    }
  });
}
function draw(i: Instance) {
  if (!i.width || !i.height) return;
  const t = reduced(i) ? i.state.still : i.time;
  poseFor(
    i.state,
    Math.min(duration(i.state) - 0.0001, Math.max(0, t)),
    i.target,
  );
  if (reduced(i)) {
    for (const k of BASE_KEYS) i.pose[k] = i.target[k];
  } else {
    const u = Math.min(1, i.transition / 0.38);
    const amount =
      u >= 1
        ? 1
        : (1 - (1 + 7 * u) * Math.exp(-7 * u)) / (1 - 8 * Math.exp(-7));
    for (const k of BASE_KEYS)
      i.pose[k] = i.from[k] + (i.target[k] - i.from[k]) * amount;
  }
  drawMascot(i.ctx, i.state, t, {
    width: i.width,
    height: i.height,
    pixelRatio: i.dpr,
    pose: i.pose,
  });
  i.dirty = false;
}
function tick(now: number) {
  raf = 0;
  if (document.hidden) {
    previous = 0;
    return;
  }
  const dt = previous ? Math.min(0.045, (now - previous) / 1000) : 1 / 60;
  previous = now;
  let active = false;
  for (const i of instances) {
    if (!i.visible) continue;
    if (moving(i)) {
      const step = dt * Math.max(0.25, Math.min(2, i.options.speed ?? 1));
      i.time += step;
      i.transition += dt;
      const d = duration(i.state);
      if (i.time >= d) {
        if (i.state.kind === "loop" || i.state.id === "loading") i.time %= d;
        else {
          i.time = d - 0.0001;
          i.finished = true;
          if (!i.doneNotified) {
            i.doneNotified = true;
            i.options.onComplete?.();
          }
        }
      }
      i.dirty = true;
    }
    if (i.dirty) draw(i);
    active ||= moving(i);
  }
  if (active) raf = requestAnimationFrame(tick);
  else previous = 0;
}
function resize(i: Instance) {
  const rect = i.canvas.getBoundingClientRect();
  i.width = rect.width;
  i.height = rect.height;
  i.dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(i.width * i.dpr)),
    h = Math.max(1, Math.round(i.height * i.dpr));
  if (i.canvas.width !== w || i.canvas.height !== h) {
    i.canvas.width = w;
    i.canvas.height = h;
  }
  i.dirty = true;
  if (i.visible) draw(i);
  wake();
}
export function mountMascot(
  canvas: HTMLCanvasElement,
  options: MascotOptions = {},
): MascotController {
  hook();
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return { setState() {}, configure() {}, replay() {}, destroy() {} };
  const s = resolveState(options.state || "idle");
  const i: Instance = {
    canvas,
    ctx,
    state: s,
    options: { ...options },
    time: options.paused ? s.still : 0,
    transition: 1,
    from: makePose(),
    pose: makePose(),
    target: makePose(),
    visible: !("IntersectionObserver" in window),
    width: 0,
    height: 0,
    dpr: 1,
    dirty: true,
    finished: false,
    doneNotified: false,
  };
  instances.add(i);
  const change = (state: string, force = false) => {
    const next = resolveState(state);
    if (!force && next.id === i.state.id) return;
    i.from = { ...i.pose };
    i.state = next;
    i.time = i.options.paused ? next.still : 0;
    i.transition = 0;
    i.finished = false;
    i.doneNotified = false;
    i.dirty = true;
    if (i.options.paused || reduced(i)) {
      i.transition = 1;
      if (i.visible) draw(i);
    }
    wake();
  };
  if ("IntersectionObserver" in window) {
    i.io = new IntersectionObserver(
      (entries) => {
        i.visible = entries[0].isIntersecting;
        i.dirty = true;
        wake();
      },
      { rootMargin: "30px" },
    );
    i.io.observe(canvas);
  }
  if ("ResizeObserver" in window) {
    i.ro = new ResizeObserver(() => resize(i));
    i.ro.observe(canvas);
  }
  resize(i);
  wake();
  return {
    setState: (state) => change(state),
    configure: (next) => {
      const newState = next.state;
      i.options = { ...i.options, ...next };
      if (newState) change(newState);
      i.dirty = true;
      if (i.visible) draw(i);
      wake();
    },
    replay: () => change(i.state.id, true),
    destroy: () => {
      i.io?.disconnect();
      i.ro?.disconnect();
      instances.delete(i);
      if (!instances.size) {
        cancelAnimationFrame(raf);
        raf = 0;
        previous = 0;
      }
    },
  };
}
