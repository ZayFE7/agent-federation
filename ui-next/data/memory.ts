import type { Memory, Skill } from "../types";

export const seedMemories: Memory[] = [
  {
    id: "mem-1",
    text: "Prefers short summaries that lead with what changed.",
    category: "preference",
    importance: 3,
    origin: "Chat · Morning brief",
    date: "2026-10-02T09:00:00-07:00",
  },
  {
    id: "mem-2",
    text: "Never delete starred email, even if it looks promotional.",
    category: "preference",
    importance: 3,
    origin: "Chat · Clean promotional email",
    date: "2026-11-01T09:01:00-08:00",
  },
  {
    id: "mem-3",
    text: "Priya Raman leads design reviews and owns the agenda.",
    category: "person",
    importance: 2,
    origin: "Calendar",
    date: "2026-10-14T10:00:00-07:00",
  },
  {
    id: "mem-4",
    text: "Works Pacific Time; no meetings before 9:00 AM.",
    category: "fact",
    importance: 2,
    origin: "Settings",
    date: "2026-09-30T08:00:00-07:00",
  },
  {
    id: "mem-5",
    text: "Notes app should stay local-only — no accounts or sync.",
    category: "project",
    importance: 2,
    origin: "Chat · Build a notes app",
    date: "2026-10-31T15:48:00-07:00",
  },
  {
    id: "mem-6",
    text: "Research briefs: primary docs over blog posts.",
    category: "preference",
    importance: 2,
    origin: "Goal · Research brief",
    date: "2026-11-01T08:05:00-08:00",
  },
  {
    id: "mem-7",
    text: "Studio North invoices are due on the 1st business day.",
    category: "fact",
    importance: 1,
    origin: "Inbox",
    date: "2026-10-20T11:00:00-07:00",
  },
];

export const seedSkills: Skill[] = [
  {
    id: "sk-triage",
    name: "inbox-triage",
    description:
      "Sorts unread mail into reply, read later and archive — and drafts replies in your voice.",
    loading: "loaded",
    uses: 24,
    addedAt: "2026-09-20T10:00:00-07:00",
    body: `---
name: inbox-triage
description: Sort unread mail and draft replies.
---

# Inbox triage

1. Group unread mail into **Reply**, **Read later**, **Archive**.
2. Never touch starred mail or anyone in contacts.
3. Draft replies in Maya's voice: short, warm, no exclamation marks.
4. Any send, archive or trash goes through the normal approval step.`,
  },
  {
    id: "sk-release",
    name: "release-notes",
    description:
      "Turns merged pull requests into readable release notes grouped by impact.",
    loading: "on-demand",
    uses: 7,
    addedAt: "2026-10-05T10:00:00-07:00",
    body: `---
name: release-notes
description: Write release notes from merged PRs.
---

# Release notes

- Group changes as New, Improved, Fixed.
- One sentence per change, user-facing language.
- Link each line to its PR.
- Publishing the notes requires approval.`,
  },
  {
    id: "sk-study",
    name: "study-guide",
    description:
      "Builds a study guide with key ideas, examples and a short self-quiz.",
    loading: "on-demand",
    uses: 3,
    addedAt: "2026-10-22T10:00:00-07:00",
    body: `---
name: study-guide
description: Create a study guide with a self-quiz.
---

# Study guide

1. Summarize the 5–7 key ideas.
2. Give one worked example per idea.
3. End with 5 quiz questions and an answer key.`,
  },
];
