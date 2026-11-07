import type { ScreenId, Tone } from "../types";

export interface AwayItem {
  id: string;
  time: string;
  title: string;
  detail: string;
  tone: Tone;
  link: { screen: ScreenId; id?: string };
}

export const awayTimeline: AwayItem[] = [
  {
    id: "w1",
    time: "2026-11-01T09:12:00-08:00",
    title: "Sorted your inbox",
    detail: "41 promotional threads ready for Trash — waiting on you",
    tone: "attention",
    link: { screen: "approvals", id: "a-promo" },
  },
  {
    id: "w2",
    time: "2026-11-01T08:40:00-08:00",
    title: "Drafted the durable streams brief",
    detail: "1,840 words · one citation missing",
    tone: "accent",
    link: { screen: "goals", id: "g-streams" },
  },
  {
    id: "w3",
    time: "2026-11-01T06:00:00-08:00",
    title: "Checked the pricing page",
    detail: "No changes since yesterday",
    tone: "healthy",
    link: { screen: "automations", id: "r-docs" },
  },
  {
    id: "w4",
    time: "2026-10-31T16:20:00-07:00",
    title: "Built your notes app",
    detail: "12 tests passing · build needs one fix",
    tone: "neutral",
    link: { screen: "chat", id: "c-notes" },
  },
];

export const weekStats = {
  tasksCompleted: 18,
  hoursSaved: 4.5,
};

export const heroExamples = [
  "Summarize unread mail from this week",
  "Find a 2-hour focus slot on Thursday",
  "Draft release notes from merged PRs",
];

export const chatStarters = [
  {
    id: "s1",
    title: "Clean up promotional email",
    body: "Finds promos and asks before trashing anything.",
    prompt:
      "Find promotional emails from the last 30 days and trash them — keep anything personal.",
  },
  {
    id: "s2",
    title: "Research with citations",
    body: "A short brief where every claim has a source.",
    prompt:
      "Research the best open-source note-taking apps and cite every claim.",
  },
  {
    id: "s3",
    title: "Draft a weekly update",
    body: "Pulls from calendar and tasks. Never sent without you.",
    prompt:
      "Draft my weekly update from this week’s calendar and completed tasks.",
  },
  {
    id: "s4",
    title: "Tidy my workspace",
    body: "Sorts loose files with a snapshot first.",
    prompt:
      "Tidy my workspace: sort loose files into folders and write an index.",
  },
];
