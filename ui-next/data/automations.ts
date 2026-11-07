import type { Automation } from "../types";

export const seedAutomations: Automation[] = [
  {
    id: "r-brief",
    name: "Morning brief",
    instructions:
      "Each weekday morning, summarize today’s calendar, anything in my inbox that needs a reply, and the weather. Keep it under 150 words and lead with what changed since yesterday.",
    trigger: {
      type: "schedule",
      schedule: { freq: "weekdays", time: "07:30" },
    },
    checks: "Calendar, unread inbox, local weather",
    does: "Posts a 150-word brief and a transcript in the target chat",
    timezone: "America/Los_Angeles",
    targetChatId: "c-brief",
    enabled: true,
    history: [
      {
        id: "h1",
        time: "2026-10-30T07:30:00-07:00",
        result: "success",
        note: "Brief posted · 142 words",
      },
      {
        id: "h2",
        time: "2026-10-29T07:30:00-07:00",
        result: "success",
        note: "Brief posted · 151 words",
      },
      {
        id: "h3",
        time: "2026-10-28T07:30:00-07:00",
        result: "skipped",
        note: "Calendar was empty — nothing to brief",
      },
    ],
    createdAt: "2026-10-01T09:00:00-07:00",
  },
  {
    id: "r-inbox",
    name: "Weekly inbox review",
    instructions:
      "Every Friday afternoon, group unread mail by sender type, suggest what to archive, and draft replies for anything waiting on me. Never send or delete without asking.",
    trigger: {
      type: "schedule",
      schedule: { freq: "weekly", time: "16:00", weekday: 5 },
    },
    checks: "Unread mail from the past 7 days",
    does: "Suggests archives and drafts replies — asks before acting",
    timezone: "America/Los_Angeles",
    targetChatId: "c-inbox",
    enabled: true,
    history: [
      {
        id: "h1",
        time: "2026-10-30T16:00:00-07:00",
        result: "success",
        note: "12 drafts · 1 approval requested",
      },
      {
        id: "h2",
        time: "2026-10-23T16:00:00-07:00",
        result: "success",
        note: "8 drafts prepared",
      },
    ],
    createdAt: "2026-09-18T12:00:00-07:00",
  },
  {
    id: "r-docs",
    name: "Docs page watcher",
    instructions:
      "Watch the durable streams pricing page. If prices, limits or regions change, post a short diff and update the research brief’s comparison table as a draft.",
    trigger: {
      type: "watch",
      url: "https://docs.streams.example/pricing",
      everyHours: 6,
    },
    checks: "Compares the page with the last snapshot",
    does: "Posts a diff summary when pricing or limits change",
    timezone: "America/Los_Angeles",
    targetChatId: "c-streams",
    enabled: true,
    history: [
      {
        id: "h1",
        time: "2026-11-01T06:00:00-08:00",
        result: "success",
        note: "No changes since last check",
      },
      {
        id: "h2",
        time: "2026-11-01T00:00:00-07:00",
        result: "success",
        note: "No changes since last check",
      },
      {
        id: "h3",
        time: "2026-10-31T18:00:00-07:00",
        result: "failed",
        note: "Page returned 503 — retried at 18:05, succeeded",
      },
    ],
    createdAt: "2026-10-25T10:00:00-07:00",
  },
  {
    id: "r-repo",
    name: "Repo hooks",
    instructions:
      "When someone pushes to main, summarize the commits and flag anything touching the build config.",
    trigger: {
      type: "webhook",
      source: "GitHub · northwind/blip-notes",
      event: "push to main",
      endpoint: "https://hooks.blip.example/demo/rh-7k2",
    },
    checks: "Commits pushed to main",
    does: "Summarizes commits and flags build-config changes",
    timezone: "America/Los_Angeles",
    targetChatId: "c-repo-updates",
    enabled: false,
    autoPausedReason: "Auto-paused: its target chat was deleted.",
    lastError: {
      message:
        "Target chat “Repo updates” no longer exists, so results had nowhere to go.",
      remedy: "choose-chat",
    },
    history: [
      {
        id: "h1",
        time: "2026-10-31T11:14:00-07:00",
        result: "failed",
        note: "Target chat missing — auto-paused",
      },
      {
        id: "h2",
        time: "2026-10-30T15:02:00-07:00",
        result: "success",
        note: "3 commits summarized",
      },
    ],
    createdAt: "2026-10-12T10:00:00-07:00",
  },
];
