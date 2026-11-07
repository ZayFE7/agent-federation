import type { Conversation } from "../types";

export const seedConversations: Conversation[] = [
  {
    id: "c-inbox",
    title: "Clean promotional email",
    pinned: true,
    updatedAt: "2026-11-01T09:12:00-08:00",
    goalId: "g-promo",
    files: ["f-report"],
    plan: [
      { id: "p1", label: "Scan the last 30 days of mail", status: "done" },
      {
        id: "p2",
        label: "Exclude personal, starred and contacts",
        status: "done",
      },
      { id: "p3", label: "Prepare a reversible Trash action", status: "done" },
      {
        id: "p4",
        label: "Move threads after your approval",
        status: "waiting",
      },
    ],
    messages: [
      {
        id: "m-i1",
        role: "user",
        time: "2026-11-01T08:58:00-08:00",
        text: "Find promotional emails from the last month and clear them out. Keep anything personal.",
      },
      {
        id: "m-i2",
        role: "agent",
        time: "2026-11-01T09:12:00-08:00",
        approvalId: "a-promo",
        artifactId: "f-report",
        events: [
          {
            id: "e1",
            kind: "plan",
            title: "Planned the cleanup",
            outcome: "3 steps",
            status: "done",
            detail:
              "Scan recent mail → filter out anything personal → prepare a reversible Trash action for your review.",
          },
          {
            id: "e2",
            kind: "search",
            title: "Searched Gmail",
            outcome: "58 threads matched",
            status: "done",
            command: "gmail.search  category:promotions newer_than:30d",
          },
          {
            id: "e3",
            kind: "read",
            title: "Sorted by sender",
            outcome: "41 promotional · 17 kept",
            status: "done",
            detail:
              "Kept 17 threads: 9 from contacts, 5 starred, 3 receipts you replied to.",
          },
          {
            id: "e4",
            kind: "verify",
            title: "Double-checked exclusions",
            outcome: "0 personal threads affected",
            status: "done",
          },
          {
            id: "e5",
            kind: "approval",
            title: "Asked before moving to Trash",
            outcome: "Waiting on you",
            status: "waiting",
          },
        ],
        text: "I found **41 promotional threads** from the last 30 days that are safe to clear.\n\n- Personal mail, starred threads and anyone in your contacts are excluded.\n- Moving to Trash is reversible for 30 days.\n- A cleanup report is saved in your Library.\n\nI won’t move anything until you approve the exact action.",
      },
    ],
  },
  {
    id: "c-streams",
    title: "Research brief: durable streams",
    pinned: true,
    updatedAt: "2026-11-01T08:40:00-08:00",
    goalId: "g-streams",
    files: ["f-sdk-notes"],
    plan: [
      { id: "p1", label: "Find primary sources", status: "done" },
      { id: "p2", label: "Compare three providers", status: "done" },
      { id: "p3", label: "Draft the brief", status: "done" },
      { id: "p4", label: "Cite every claim", status: "blocked" },
    ],
    messages: [
      {
        id: "m-s1",
        role: "user",
        time: "2026-11-01T08:02:00-08:00",
        text: "Write a research brief on durable streams — how they work, who offers them, rough pricing. Cite everything.",
      },
      {
        id: "m-s2",
        role: "agent",
        time: "2026-11-01T08:40:00-08:00",
        events: [
          {
            id: "e1",
            kind: "plan",
            title: "Planned the research",
            outcome: "4 steps",
            status: "done",
          },
          {
            id: "e2",
            kind: "search",
            title: "Searched the web",
            outcome: "14 sources found",
            status: "done",
            command: 'web.search  "durable streams" resumable HTTP offsets',
          },
          {
            id: "e3",
            kind: "read",
            title: "Read 6 sources",
            outcome: "3 primary kept",
            status: "done",
            detail:
              "Kept 3 primary sources. Skipped 3 marketing pages without technical detail.",
          },
          {
            id: "e4",
            kind: "write",
            title: "Wrote the brief",
            outcome: "Draft v2 · 1,840 words",
            status: "done",
          },
          {
            id: "e5",
            kind: "verify",
            title: "Citation check",
            outcome: "1 claim missing a source",
            status: "attention",
            detail:
              "Provider C’s pricing has no public source. This is a blocker, not an error — Blip needs your call before finishing.",
          },
        ],
        citations: [
          {
            n: 1,
            label: "Resumable HTTP streaming — protocol notes",
            source: "docs.streams.example",
          },
          {
            n: 2,
            label: "Offsets, checkpoints and replay",
            source: "engineering.relay.example",
          },
          {
            n: 3,
            label: "Provider A & B public pricing",
            source: "pricing.cloudstream.example",
          },
        ],
        text: "### Durable streams, in brief\n\nDurable streams are HTTP streams that survive disconnects: the client resumes from an offset instead of starting over [1].\n\n- **How they work** — the server stores every chunk with an increasing offset, so a reconnecting client asks for “everything after 4,812” [1][2].\n- **Who offers them** — two managed providers and one self-hosted option match your criteria [2][3].\n- **Pricing** — Providers A and B publish usage-based pricing [3]. Provider C’s pricing isn’t public, so that row still has no source.\n\nI paused here rather than guess. Share a source for Provider C, or tell me to mark it as unknown.",
      },
    ],
  },
  {
    id: "c-notes",
    title: "Build a notes app",
    pinned: false,
    updatedAt: "2026-10-31T16:20:00-07:00",
    files: ["f-notes-app", "f-usage", "f-sdk-notes", "f-cover"],
    plan: [
      { id: "p1", label: "Sketch a local-only notes app", status: "done" },
      { id: "p2", label: "Write the app and a store", status: "done" },
      { id: "p3", label: "Run the test suite", status: "done" },
      { id: "p4", label: "Pass the production build", status: "blocked" },
    ],
    messages: [
      {
        id: "m-n1",
        role: "user",
        time: "2026-10-31T15:48:00-07:00",
        text: "Make me a tiny notes app I can open in a browser. Local only, no accounts.",
      },
      {
        id: "m-n2",
        role: "agent",
        time: "2026-10-31T16:20:00-07:00",
        artifactId: "f-notes-app",
        events: [
          {
            id: "e1",
            kind: "plan",
            title: "Planned the app",
            outcome: "4 steps",
            status: "done",
          },
          {
            id: "e2",
            kind: "read",
            title: "Read Agents SDK notes.md",
            outcome: "Reused 2 patterns",
            status: "done",
          },
          {
            id: "e3",
            kind: "tool",
            title: "Wrote 3 files",
            outcome: "3 files · 6.1 KB",
            status: "done",
            command: "workspace.write  index.html  src/store.ts  usage.ts",
          },
          {
            id: "e4",
            kind: "tool",
            title: "Ran the tests",
            outcome: "Passed · 12 tests",
            status: "done",
            command: "npm test",
            output:
              "> notes@0.1.0 test\n> vitest run\n\n ✓ src/store.test.ts (8)\n ✓ src/render.test.ts (4)\n\n Test Files  2 passed (2)\n      Tests  12 passed (12)\n   Duration  1.18s",
          },
          {
            id: "e5",
            kind: "tool",
            title: "Production build",
            outcome: "Failed · TS2322",
            status: "failed",
            retryable: true,
            command: "npm run build",
            output:
              "> notes@0.1.0 build\n> tsc && vite build\n\nsrc/store.ts:18:5 - error TS2322: Type 'string | undefined' is not assignable to type 'string'.\n\n18     title: draft.title,\n       ~~~~~\n\nFound 1 error in src/store.ts:18",
          },
        ],
        text: "The notes app works and all **12 tests pass**, but the production build stops on one type error in `store.ts` — a note’s title can be empty.\n\n- The preview in your Library works as-is.\n- Fix: default empty titles to “Untitled”.\n\nRetry the build from the step above once you’re happy with the fix.",
      },
    ],
  },
  {
    id: "c-brief",
    title: "Morning brief · Oct 30",
    pinned: false,
    updatedAt: "2026-10-30T07:31:00-07:00",
    files: ["f-brief-audio", "f-transcript"],
    plan: [
      { id: "p1", label: "Check calendar and inbox", status: "done" },
      { id: "p2", label: "Write a 150-word brief", status: "done" },
      { id: "p3", label: "Produce audio version", status: "done" },
    ],
    messages: [
      {
        id: "m-b1",
        role: "system",
        time: "2026-10-30T07:30:00-07:00",
        text: "Started by the “Morning brief” routine.",
      },
      {
        id: "m-b2",
        role: "agent",
        time: "2026-10-30T07:31:00-07:00",
        artifactId: "f-brief-audio",
        events: [
          {
            id: "e1",
            kind: "tool",
            title: "Checked your calendar",
            outcome: "4 events today",
            status: "done",
          },
          {
            id: "e2",
            kind: "search",
            title: "Scanned your inbox",
            outcome: "2 need replies",
            status: "done",
          },
          {
            id: "e3",
            kind: "write",
            title: "Wrote the brief",
            outcome: "142 words",
            status: "done",
          },
          {
            id: "e4",
            kind: "tool",
            title: "Audio version",
            outcome: "Transcript only · voice not set up",
            status: "attention",
            detail:
              "Text-to-speech isn’t configured, so Blip saved a transcript instead of audio.",
          },
        ],
        text: "Good morning. Three things today:\n\n1. **Design review** at 10:00 — Priya added two agenda items.\n2. **Invoice from Studio North** is due Monday.\n3. Rain after 3 PM — the gym session might move indoors.\n\nThe transcript is in your Library.",
      },
    ],
  },
];
