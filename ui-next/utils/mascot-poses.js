// BLIP character geometry and 20 pose definitions adapted from the user-provided reference gallery.
// Source: https://github.com/ZayFE7/blip-design-gallery/blob/main/mascot-animation-lab.html
// Rendering changes: transparent stage, continuous pose input, soft loading crossfade.
const MascotStates = (() => {
  "use strict";

  const P = Math.PI;
  const TAU = P * 2;
  const DEG = P / 180;
  const BG = "#FCFCFC";
  const INK = "#000000";
  const EYE = "#FFFFFF";
  const BLINK_MIN = 0.16;
  const BLINK_LEN = 0.26;

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const smooth = (v) => {
    v = clamp01(v);
    return v * v * (3 - 2 * v);
  };
  const easeOut3 = (v) => {
    v = clamp01(v);
    const a = 1 - v;
    return 1 - a * a * a;
  };
  const easeInOut3 = (v) => {
    v = clamp01(v);
    return v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2;
  };
  /* Damped overshoot arrival: leaves fast, lands at exactly 1 with one small overshoot. */
  const backOut = (v, k) => {
    v = clamp01(v);
    const c = k + 1;
    const a = v - 1;
    return 1 + c * a * a * a + k * a * a;
  };
  const seg = (t, a, b) => clamp01((t - a) / (b - a));
  /* A gravity hop: parabolic, returns 0 outside its window. */
  const hopAt = (t, a, d, h) => {
    const u = (t - a) / d;
    return u > 0 && u < 1 ? -4 * h * u * (1 - u) : 0;
  };
  /* Fast squash in, slow release out. */
  const impact = (t, land, amp) => {
    const u = (t - land) / 0.17;
    if (u < 0 || u > 1) return 0;
    return u < 0.18
      ? amp * Math.sin((P * 0.5 * u) / 0.18)
      : amp * Math.cos((P * 0.5 * (u - 0.18)) / 0.82);
  };
  /* Four stepped saccades across one sweep, with tiny holds. */
  const sw = (v) => {
    const k = Math.floor(v * 4);
    const f = v * 4 - k;
    return (k + smooth(f * 3)) / 4;
  };
  /* A pinch, not a vanish. 75 ms close, 40 ms hold, 145 ms open. */
  const blinkOpen = (t, list) => {
    if (!list || list.length === 0) return 1;
    for (let i = 0; i < list.length; i++) {
      const dt = t - list[i];
      if (dt >= 0 && dt <= BLINK_LEN) {
        if (dt < 0.075) return 1 - (1 - BLINK_MIN) * smooth(dt / 0.075);
        if (dt < 0.115) return BLINK_MIN;
        return BLINK_MIN + (1 - BLINK_MIN) * smooth((dt - 0.115) / 0.145);
      }
    }
    return 1;
  };

  /* Hoisted so the render loop allocates nothing. */
  const SEARCH_POINTS = [
    [-0.26, 0.16],
    [0.26, 0.12],
    [0.22, -0.14],
    [-0.22, -0.14],
    [0, 0.06],
  ];

  const STATES = [
    /* ---------------------------------------------------------------- core 12 */
    {
      id: "listening",
      name: "Listening",
      note: "leans in, one slow glance",
      group: "core",
      kind: "loop",
      duration: 3.2,
      still: 1.45,
      blinks: [0.55],
      write(t, o) {
        o.L = 0.4;
        o.th = 0.25;
        o.gap = 0.33;
        o.ey = 0;
        o.sx = 1.04;
        o.sy = 1.04;
        o.dy = 0.02;
        let g = 0;
        if (t > 1.0) {
          g =
            backOut(seg(t, 1.0, 1.28), 1.2) *
            (1 - backOut(seg(t, 1.9, 2.18), 1.2));
        }
        o.ex = -0.02 - 0.14 * g;
        o.ey = 0.07 * g;
        o.tilt = -2 * g;
        o.dx = o.ex * 0.15;
        o.dy = 0.02 - o.ey * 0.1;
      },
    },
    {
      id: "reading",
      name: "Reading a file",
      note: "line by line, body leads",
      group: "core",
      kind: "loop",
      duration: 4.8,
      still: 2.4,
      blinks: [4.45],
      write(t, o) {
        const u = t / 4.8;
        let x = 0;
        let y = 0;
        if (u < 0.38) {
          x = sw(u / 0.38);
        } else if (u < 0.5) {
          const k = smooth((u - 0.38) / 0.12);
          x = 1 - k;
          y = k;
        } else if (u < 0.88) {
          x = sw((u - 0.5) / 0.38);
          y = 1;
        } else {
          const k = smooth((u - 0.88) / 0.12);
          x = 1 - k;
          y = 1 - k;
        }
        o.L = 0.2;
        o.th = 0.24;
        o.ex = -0.24 + 0.48 * x;
        o.ey = -0.2 - 0.07 * y;
        o.dx = o.ex * 0.15;
        o.dy = 0.085 - o.ey * 0.1;
      },
    },
    {
      id: "writing",
      name: "Writing a file",
      note: "keystrokes, eyes locked",
      group: "core",
      kind: "loop",
      duration: 3.2,
      still: 0.95,
      blinks: [2.55],
      write(t, o) {
        o.L = 0.19;
        o.th = 0.25;
        o.gap = 0.31;
        o.ex = -0.04;
        o.ey = -0.17;
        const m = (t - 0.3) % 0.22;
        const tap =
          t > 0.3 && t < 1.75 && m < 0.13 ? Math.sin((P * m) / 0.13) : 0;
        o.sy = 1 - 0.015 * tap;
        o.dx = o.ex * 0.15;
        o.dy = -o.ey * 0.1 + 0.012 * tap;
      },
    },
    {
      id: "editing",
      name: "Editing",
      note: "scan, spot, patch",
      group: "core",
      kind: "one shot",
      duration: 3.6,
      still: 1.52,
      blinks: [2.8],
      write(t, o) {
        const on =
          backOut(seg(t, 0.15, 0.35), 1.0) *
          (1 - backOut(seg(t, 2.1, 2.4), 1.0));
        const scan = -0.2 + 0.4 * sw(seg(t, 0.35, 1.3));
        const ping = Math.exp(-Math.pow((t - 1.52) / 0.08, 2));
        const m = (t - 1.75) % 0.11;
        const tap =
          t > 1.75 && t < 2.1 && m < 0.06 ? Math.sin((P * m) / 0.06) : 0;
        o.L = 0.31 + (0.2 - 0.31) * on + 0.18 * ping;
        o.th = 0.25 - 0.005 * on + 0.02 * ping;
        o.gap = 0.31 + 0.01 * on;
        o.ex = -0.02 + (scan + 0.02) * on;
        o.ey = -0.03 - 0.15 * on;
        o.sx = 1 + 0.05 * ping;
        o.sy = 1 + 0.05 * ping - 0.01 * tap;
        o.dx = o.ex * 0.15;
        o.dy = 0.07 * on + 0.018 * tap;
      },
    },
    {
      id: "searching",
      name: "Searching",
      note: "five darts, wide eyes",
      group: "core",
      kind: "loop",
      duration: 3.0,
      still: 1.0,
      blinks: [1.92],
      write(t, o) {
        const p = SEARCH_POINTS;
        const u = t / 0.6;
        const i = Math.floor(u) % 5;
        const k = backOut(seg(u % 1, 0.66, 1), 1.1);
        const a = p[i];
        const b = p[(i + 1) % 5];
        const ex = a[0] + (b[0] - a[0]) * k;
        const ey = a[1] + (b[1] - a[1]) * k;
        o.L = 0.38;
        o.th = 0.27;
        o.gap = 0.33;
        o.ex = ex;
        o.ey = ey;
        o.dx = ex * 0.2;
        o.dy = -ey * 0.2;
      },
    },
    {
      id: "running",
      name: "Running a command",
      note: "slanted eyes, heartbeat",
      group: "core",
      kind: "loop",
      duration: 1.6,
      still: 0.4,
      blinks: [],
      write(t, o) {
        const b = Math.pow(Math.sin((P * t) / 0.8), 8);
        o.L = 0.2 - 0.01 * b;
        o.th = 0.26 + 0.004 * b;
        o.slant = -11;
        o.ey = -0.05;
        o.sx = 1 + 0.045 * b;
        o.sy = 1 + 0.045 * b;
        o.dy = -0.02 * b;
      },
    },
    {
      id: "approval",
      name: "Needs approval",
      note: "glances, then a hop",
      group: "core",
      kind: "one shot",
      duration: 3.2,
      still: 1.35,
      blinks: [0.52],
      write(t, o) {
        o.L = 0.36;
        o.th = 0.25;
        o.gap = 0.33;
        const g =
          backOut(seg(t, 0.9, 1.15), 1.15) *
          (1 - backOut(seg(t, 2.45, 2.72), 1.15));
        const hop = hopAt(t, 1.8, 0.34, 0.1);
        const imp = impact(t, 2.14, 0.035);
        o.ex = -0.02 + 0.32 * g;
        o.ey = -0.03 - 0.17 * g;
        o.tilt = 2 * g;
        o.L += 0.02 * g;
        o.th += 0.008 * g;
        o.sx = 1 + 0.5 * imp;
        o.sy = 1 - 0.5 * imp;
        o.dx = o.ex * 0.15;
        o.dy = -o.ey * 0.14 + hop;
      },
    },
    {
      id: "unsure",
      name: "Not sure",
      note: "tilts, one eye longer",
      group: "core",
      kind: "loop",
      duration: 3.6,
      still: 0.9,
      blinks: [1.45],
      write(t, o) {
        const s = Math.sin((TAU * t) / 3.6);
        o.asym = 0.3;
        o.roll = 9 * s;
        o.ey = 0.06;
        o.L = 0.3;
        o.ex = 0.03 * s;
        o.dx = o.ex * 0.15;
      },
    },
    {
      id: "done",
      name: "Done",
      note: "happy arcs, two hops, rest",
      group: "core",
      kind: "one shot",
      duration: 3.2,
      still: 0.9,
      blinks: [2.45],
      write(t, o) {
        const arcs =
          backOut(seg(t, 0.04, 0.34), 1.15) *
          (1 - backOut(seg(t, 1.5, 1.8), 1.15));
        const h1 = hopAt(t, 0.28, 0.42, 0.22);
        const h2 = hopAt(t, 0.78, 0.3, 0.1);
        const imp1 = impact(t, 0.7, 0.05);
        const imp2 = impact(t, 1.08, 0.03);
        const air = (Math.abs(h1) + Math.abs(h2)) / 0.22;
        o.tilt = 90 * arcs;
        o.bend = 140 * arcs;
        o.gap = 0.31 + 0.04 * arcs;
        o.ey = -0.03 + 0.06 * arcs;
        o.L = 0.31 - 0.05 * arcs;
        o.dy = h1 + h2;
        o.sy = 1 + 0.025 * air - imp1 - 0.6 * imp2;
        o.sx = 1 - 0.015 * air + 0.6 * imp1 + 0.4 * imp2;
      },
    },
    {
      id: "oops",
      name: "Oops",
      note: "droops, shakes no",
      group: "core",
      kind: "one shot",
      duration: 3.0,
      still: 0.65,
      blinks: [2.0],
      write(t, o) {
        const droop =
          backOut(seg(t, 0.05, 0.32), 1.1) *
          (1 - backOut(seg(t, 1.08, 1.38), 1.1));
        let sh = 0;
        let rr = 0;
        if (t > 0.42 && t < 1.08) {
          const u = (t - 0.42) / 0.66;
          sh = 0.07 * (1 - u) * Math.sin(TAU * 2.5 * u);
          rr = -5 * (1 - u) * Math.sin(TAU * 2.5 * u);
        }
        o.slant = 18 * droop;
        o.L = 0.31 - 0.05 * droop;
        o.ey = -0.03 - 0.08 * droop;
        o.sx = 1 + 0.05 * droop;
        o.sy = 1 - 0.07 * droop;
        o.dy = 0.06 * droop;
        o.roll = rr;
        o.dx = sh;
      },
    },
    {
      id: "replying",
      name: "Replying",
      note: "five speech pulses",
      group: "core",
      kind: "one shot",
      duration: 2.8,
      still: 0.43,
      blinks: [2.45],
      write(t, o) {
        o.L = 0.33;
        o.gap = 0.31;
        let p = 0;
        for (let i = 0; i < 5; i++) {
          const u = (t - (0.3 + i * 0.42)) / 0.26;
          if (u > 0 && u < 1) p += Math.sin(P * u);
        }
        o.sx = 1 - 0.03 * p;
        o.sy = 1 + 0.05 * p;
        o.dy = -0.035 * p;
        o.L += 0.012 * p;
        o.ey = -0.03 + 0.01 * p;
      },
    },
    {
      id: "sleeping",
      name: "Sleeping",
      note: "closed eyes, slow breath",
      group: "core",
      kind: "loop",
      duration: 4.4,
      still: 1.1,
      blinks: [],
      write(t, o) {
        const b = Math.sin((TAU * t) / 4.4);
        o.tilt = 90;
        o.bend = -55;
        o.L = 0.28;
        o.th = 0.14;
        o.gap = 0.33;
        o.ey = -0.1;
        o.dy = 0.1 + 0.012 * b;
        o.sx = 1 + 0.02 * b;
        o.sy = 1 + 0.025 * b;
      },
    },

    /* ------------------------------------------------------------ extended 8 */
    {
      id: "idle",
      name: "Idle",
      note: "breath, two small glances",
      group: "extended",
      kind: "loop",
      duration: 6.4,
      still: 3.9,
      blinks: [2.7, 5.5],
      write(t, o) {
        const c = Math.sin((TAU * t) / 6.4);
        let g1 = 0;
        let g2 = 0;
        if (t > 1.15 && t < 2.15) {
          g1 =
            backOut(seg(t, 1.15, 1.4), 1.1) *
            (1 - backOut(seg(t, 1.9, 2.15), 1.1));
        }
        if (t > 3.5 && t < 4.55) {
          g2 =
            backOut(seg(t, 3.5, 3.75), 1.1) *
            (1 - backOut(seg(t, 4.3, 4.55), 1.1));
        }
        o.sx = 1 + 0.012 * c;
        o.sy = 1 + 0.018 * c;
        o.ex = -0.02 - 0.11 * g1 + 0.09 * g2;
        o.ey = -0.03 + 0.03 * g1;
        o.dx = o.ex * 0.15;
        o.dy = 0.004 * c - o.ey * 0.1;
      },
    },
    {
      id: "waking",
      name: "Waking",
      note: "peek, snap, look around",
      group: "extended",
      kind: "snap",
      duration: 5.8,
      still: 1.4,
      blinks: [3.5],
      write(t, o) {
        const ballDown =
          t < 0.55
            ? 1
            : t < 0.87
              ? 1 - easeOut3(seg(t, 0.55, 0.87))
              : t < 4.3
                ? 0
                : easeInOut3(seg(t, 4.3, 4.95));
        const eyeDoze =
          t < 0.87 ? 1 : t < 4.3 ? 0 : easeInOut3(seg(t, 4.3, 4.95));
        let g1 = 0;
        let g2 = 0;
        if (t > 1.15 && t < 2.25) {
          g1 =
            backOut(seg(t, 1.15, 1.42), 1.15) *
            (1 - backOut(seg(t, 2.0, 2.25), 1.1));
        }
        if (t > 2.4 && t < 3.35) {
          g2 =
            backOut(seg(t, 2.4, 2.67), 1.15) *
            (1 - backOut(seg(t, 3.1, 3.35), 1.1));
        }
        const settle =
          t > 0.87
            ? 0.03 *
              Math.exp(-9 * (t - 0.87)) *
              Math.sin(TAU * 3.4 * (t - 0.87))
            : 0;
        o.dx = 0.11 * ballDown;
        o.dy = 0.62 * ballDown + settle;
        o.sx = 1 - 0.11 * ballDown;
        o.sy = 1 - 0.1 * ballDown;
        o.L = 0.31 - 0.05 * eyeDoze;
        o.th = 0.25 - 0.15 * eyeDoze;
        o.gap = 0.31 + 0.03 * eyeDoze;
        o.ex = -0.02 + 0.18 * eyeDoze - 0.18 * g1 + 0.26 * g2;
        o.ey = -0.03 + 0.35 * eyeDoze + 0.4 * g1 + 0.36 * g2;
        o.tilt = 64 * eyeDoze;
        o.dx += (o.ex + 0.02) * 0.12;
        o.dy += -(o.ey + 0.03) * 0.12;
      },
    },
    {
      id: "thinking",
      name: "Thinking",
      note: "orbit with one short eye",
      group: "extended",
      kind: "loop",
      duration: 5.2,
      still: 1.3,
      blinks: [2.4],
      write(t, o) {
        const a = (TAU * t) / 5.2;
        const c = Math.cos(a);
        const s = Math.sin(a);
        o.ex = -0.12 + 0.11 * c;
        o.ey = 0.1 + 0.08 * s;
        o.dx = o.ex * 0.16;
        o.dy = -o.ey * 0.16;
        o.roll = 4 * s;
        o.L = 0.26;
        o.th = 0.24;
        o.gap = 0.32;
        o.asym = 0.12;
      },
    },
    {
      id: "curious",
      name: "Curious",
      note: "leans in, head tilt",
      group: "extended",
      kind: "loop",
      duration: 4.4,
      still: 1.1,
      blinks: [2.9],
      write(t, o) {
        const s = Math.sin((TAU * t) / 4.4);
        o.roll = 9 * s;
        o.asym = 0.24;
        o.L = 0.38;
        o.th = 0.26;
        o.gap = 0.315;
        o.ex = -0.07 + 0.06 * s;
        o.ey = 0.01;
        o.dx = o.ex * 0.15;
        o.sx = 1.05 + 0.008 * s;
        o.sy = 1.04 + 0.008 * s;
        o.dy = 0.02;
      },
    },
    {
      id: "alert",
      name: "Alert",
      note: "pops wide, tiny shake",
      group: "extended",
      kind: "one shot",
      duration: 2.0,
      still: 0.62,
      blinks: [1.65],
      write(t, o) {
        const pop =
          backOut(seg(t, 0.14, 0.4), 1.5) *
          (1 - backOut(seg(t, 1.2, 1.48), 1.1));
        let shake = 0;
        if (t > 0.5 && t < 0.85) {
          const u = (t - 0.5) / 0.35;
          shake = 0.01 * (1 - u) * Math.sin(TAU * 4 * u);
        }
        o.L = 0.31 + 0.07 * pop;
        o.th = 0.25 + 0.02 * pop;
        o.gap = 0.31 + 0.03 * pop;
        o.ey = -0.03 + 0.09 * pop;
        o.ex = -0.02 + 0.04 * pop;
        o.sx = 1 + 0.09 * pop;
        o.sy = 1 + 0.09 * pop;
        o.dy = -0.02 * pop;
        o.dx = o.ex * 0.15 + shake;
      },
    },
    {
      id: "deep-focus",
      name: "Deep focus",
      note: "narrow eyes, held breath",
      group: "extended",
      kind: "loop",
      duration: 6.0,
      still: 1.5,
      blinks: [4.3],
      write(t, o) {
        const b = Math.sin((TAU * t) / 6.0);
        o.L = 0.24;
        o.th = 0.25;
        o.gap = 0.3;
        o.ey = -0.04;
        o.slant = -5;
        o.bend = -10;
        o.sx = 1 + 0.008 * b;
        o.sy = 1 + 0.01 * b;
        o.dy = 0.004 * b;
      },
    },
    {
      id: "offline",
      name: "Offline",
      note: "droops, no blink",
      group: "extended",
      kind: "loop",
      duration: 5.6,
      still: 1.4,
      blinks: [],
      write(t, o) {
        const s = Math.sin((TAU * t) / 5.6);
        o.tilt = 38;
        o.bend = -24;
        o.L = 0.26;
        o.th = 0.2;
        o.gap = 0.32;
        o.ey = -0.02;
        o.dy = 0.07;
        o.sx = 0.99;
        o.sy = 0.97;
        o.roll = 2 * s;
        o.dx = 0.01 * s;
      },
    },
    {
      id: "loading",
      name: "Loading",
      note: "hard cut to the spinner",
      group: "extended",
      kind: "cut",
      duration: 1.44,
      still: 0,
      blinks: [],
      write(t, o) {
        o.spin = 1;
      },
    },
  ];

  const BY_ID = Object.create(null);
  for (let i = 0; i < STATES.length; i++) BY_ID[STATES[i].id] = STATES[i];

  const resolveState = (state) => {
    if (state && state.write) return state;
    if (typeof state === "number")
      return STATES[((state % STATES.length) + STATES.length) % STATES.length];
    if (typeof state === "string") return BY_ID[state] || STATES[0];
    return STATES[0];
  };

  const BASE_KEYS = [
    "dx",
    "dy",
    "sx",
    "sy",
    "ex",
    "ey",
    "gap",
    "L",
    "th",
    "bend",
    "tilt",
    "slant",
    "asym",
    "roll",
    "blink",
    "spin",
  ];

  function resetPose(o) {
    o.dx = 0;
    o.dy = 0;
    o.sx = 1;
    o.sy = 1;
    o.ex = -0.02;
    o.ey = -0.03;
    o.gap = 0.31;
    o.L = 0.31;
    o.th = 0.25;
    o.bend = 0;
    o.tilt = 0;
    o.slant = 0;
    o.asym = 0;
    o.roll = 0;
    o.blink = 1;
    o.spin = 0;
  }

  function poseFor(state, t, o) {
    resetPose(o);
    state.write(t, o);
    o.blink = blinkOpen(t, state.blinks);
    return o;
  }

  const SCRATCH = {};

  function drawSpinner(ctx, cx, cy, R, t, mix = 1) {
    const step = 0;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((TAU * t) / 1.44);
    ctx.lineCap = "round";
    ctx.lineWidth = R * 0.16;
    ctx.strokeStyle = INK;
    for (let j = 0; j < 8; j++) {
      const trail = (step - j + 8) % 8;
      ctx.globalAlpha = mix * (1 - trail * 0.12);
      ctx.save();
      ctx.rotate((j * P) / 4);
      ctx.beginPath();
      ctx.moveTo(0, -R * 0.3);
      ctx.lineTo(0, -R * 0.68);
      ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /**
   * Draw one mascot frame.
   * drawMascot(ctx, state, t, options)
   * options: { width, height, pixelRatio, background }
   */
  function drawMascot(ctx, state, t, options) {
    const st = resolveState(state);
    const opt = options || {};
    const o = opt.pose || poseFor(st, t, SCRATCH);
    const dpr = opt.pixelRatio || 1;
    const w = opt.width || ctx.canvas.width / dpr;
    const h = opt.height || ctx.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (opt.background) {
      ctx.fillStyle = opt.background;
      ctx.fillRect(0, 0, w, h);
    }

    const R = Math.min(w, h) * 0.28;
    const cx = w * 0.5;
    const cy = h * 0.5;

    const spinMix = clamp01(o.spin);
    if (spinMix > 0.001) drawSpinner(ctx, cx, cy, R, t, spinMix);
    if (spinMix >= 0.999) return;

    ctx.save();
    ctx.globalAlpha = 1 - spinMix;
    ctx.translate(cx + o.dx * R, cy + o.dy * R);
    ctx.scale(o.sx, o.sy);

    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fill();

    ctx.strokeStyle = EYE;
    ctx.lineWidth = o.th * R;
    ctx.lineCap = "round";
    const r = o.roll * DEG;
    const cr = Math.cos(r);
    const sr = Math.sin(r);

    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1;
      const ex = (o.ex + s * o.gap * cr) * R;
      const ey = (-o.ey + s * o.gap * sr) * R;
      const L = o.L * (1 + s * o.asym) * R;
      const ang = (o.tilt - s * o.slant) * DEG;
      const be = o.bend * DEG;
      const a = be < 0 ? -be : be;
      ctx.save();
      ctx.translate(ex, ey);
      ctx.scale(1, o.blink);
      ctx.rotate(ang);
      ctx.beginPath();
      if (a < 0.02) {
        ctx.moveTo(0, -L / 2);
        ctx.lineTo(0, L / 2 + 0.001);
      } else {
        if (be < 0) ctx.scale(-1, 1);
        const q = L / a;
        ctx.translate((-q * (1 - Math.cos(a / 2))) / 2, 0);
        ctx.arc(q, 0, q, P - a / 2, P + a / 2);
      }
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  return { STATES, BASE_KEYS, resetPose, poseFor, resolveState, drawMascot };
})();
export const {
  STATES,
  BASE_KEYS,
  resetPose,
  poseFor,
  resolveState,
  drawMascot,
} = MascotStates;
