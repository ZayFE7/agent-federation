/** @type {import('tailwindcss').Config} */
const c = (v) => `rgb(var(--${v}) / <alpha-value>)`;

export default {
  darkMode: "class",
  content: [
    "./index.html",
    "./*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./pages/**/*.{ts,tsx}",
    "./contexts/**/*.{ts,tsx}",
    "./hooks/**/*.{ts,tsx}",
    "./utils/**/*.{ts,tsx}",
    "./data/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        canvas: c("canvas"),
        sidebar: c("sidebar"),
        surface: c("surface"),
        sunken: c("sunken"),
        stage: c("stage"),
        "on-accent": c("on-accent"),
        ink: { DEFAULT: c("ink"), 2: c("ink-2"), 3: c("ink-3") },
        line: { DEFAULT: c("line"), strong: c("line-strong") },
        accent: {
          DEFAULT: c("accent"),
          soft: c("accent-soft"),
          ink: c("accent-ink"),
        },
        sage: { DEFAULT: c("sage"), soft: c("sage-soft"), ink: c("sage-ink") },
        amber: {
          DEFAULT: c("amber"),
          soft: c("amber-soft"),
          ink: c("amber-ink"),
        },
        rose: { DEFAULT: c("rose"), soft: c("rose-soft"), ink: c("rose-ink") },
      },
      fontFamily: {
        sans: [
          '"DM Sans Variable"',
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        mono: [
          '"JetBrains Mono Variable"',
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      boxShadow: {
        soft: "0 1px 2px rgb(var(--shadow) / 0.04), 0 6px 20px -12px rgb(var(--shadow) / 0.14)",
        lift: "0 1px 2px rgb(var(--shadow) / 0.05), 0 14px 32px -16px rgb(var(--shadow) / 0.22)",
        pop: "0 2px 6px rgb(var(--shadow) / 0.06), 0 24px 60px -20px rgb(var(--shadow) / 0.32)",
      },
      transitionTimingFunction: {
        out: "cubic-bezier(0.23, 1, 0.32, 1)",
      },
    },
  },
  plugins: [],
};
