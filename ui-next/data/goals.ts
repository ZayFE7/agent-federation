import type { Goal } from "../types";

export const seedGoals: Goal[] = [
  {
    id: "g-promo",
    title: "Clean promotional email",
    brief:
      "Clear promotional threads from the last 30 days without touching anything personal.",
    status: "needs-you",
    progress: 75,
    currentStep: "Waiting for your approval to move 41 threads",
    eta: "Finishes within a minute of approval",
    conversationId: "c-inbox",
    criteria: [
      {
        id: "k1",
        text: "No promotional threads older than 14 days left in Inbox",
        state: "partial",
        evidence: "41 identified · waiting on approval",
      },
      {
        id: "k2",
        text: "No personal, starred, or contact mail affected",
        state: "met",
        evidence: "Verified: 17 threads excluded",
      },
      {
        id: "k3",
        text: "Cleanup report saved to Library",
        state: "met",
        evidence: "Inbox cleanup report.md · v1",
      },
    ],
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
    activity: [
      {
        id: "a1",
        time: "2026-11-01T09:12:00-08:00",
        text: "Asked for approval to move 41 threads to Trash",
        tone: "attention",
      },
      {
        id: "a2",
        time: "2026-11-01T09:10:00-08:00",
        text: "Saved Inbox cleanup report.md",
        tone: "healthy",
      },
      {
        id: "a3",
        time: "2026-11-01T09:04:00-08:00",
        text: "Excluded 17 personal or starred threads",
      },
      {
        id: "a4",
        time: "2026-11-01T08:58:00-08:00",
        text: "Goal started from chat",
      },
    ],
    budget: { toolCalls: 14, toolLimit: 40, minutes: 6, minuteLimit: 20 },
    instructions: [],
    sources: [],
    updatedAt: "2026-11-01T09:12:00-08:00",
    createdAt: "2026-11-01T08:58:00-08:00",
  },
  {
    id: "g-streams",
    title: "Research brief: durable streams",
    brief:
      "A two-page brief on durable streams: how they work, who offers them, and rough pricing — every claim cited.",
    status: "needs-you",
    progress: 58,
    currentStep: "Citation check — one pricing claim has no source",
    eta: "About 20 min after you unblock it",
    conversationId: "c-streams",
    blocker:
      "Provider C doesn’t publish pricing. Share a source, or let Blip mark that row “unknown”.",
    criteria: [
      {
        id: "k1",
        text: "Explains how durable streams work",
        state: "met",
        evidence: "Section 1 · 2 sources",
      },
      {
        id: "k2",
        text: "Compares at least three providers",
        state: "met",
        evidence: "Comparison table · 3 rows",
      },
      {
        id: "k3",
        text: "Every claim has a citation",
        state: "partial",
        evidence: "11 of 12 claims cited — Provider C pricing missing",
      },
      {
        id: "k4",
        text: "Under 2,000 words",
        state: "met",
        evidence: "1,840 words",
      },
    ],
    plan: [
      { id: "p1", label: "Find primary sources", status: "done" },
      { id: "p2", label: "Compare three providers", status: "done" },
      { id: "p3", label: "Draft the brief", status: "done" },
      { id: "p4", label: "Cite every claim", status: "blocked" },
      { id: "p5", label: "Final read-through", status: "todo" },
    ],
    activity: [
      {
        id: "a1",
        time: "2026-11-01T08:40:00-08:00",
        text: "Blocked: no public source for Provider C pricing",
        tone: "attention",
      },
      {
        id: "a2",
        time: "2026-11-01T08:31:00-08:00",
        text: "Draft v2 written · 1,840 words",
      },
      {
        id: "a3",
        time: "2026-11-01T08:14:00-08:00",
        text: "Kept 3 primary sources of 14 found",
      },
    ],
    budget: { toolCalls: 22, toolLimit: 60, minutes: 38, minuteLimit: 90 },
    instructions: ["Prefer primary documentation over blog posts."],
    sources: ["f-sdk-notes"],
    updatedAt: "2026-11-01T08:40:00-08:00",
    createdAt: "2026-11-01T08:02:00-08:00",
  },
  {
    id: "g-metrics",
    title: "Weekly metrics digest",
    brief:
      "Pull signups and activation numbers into a one-page digest for Monday’s team sync.",
    status: "in-progress",
    progress: 40,
    currentStep: "Exporting signups from the shared spreadsheet",
    eta: "~15 min · demo estimate",
    conversationId: null,
    error:
      "Spreadsheet export timed out after 30 s. Blip will retry automatically in a few minutes.",
    criteria: [
      {
        id: "k1",
        text: "Signups and activation for the last 7 days",
        state: "unmet",
      },
      {
        id: "k2",
        text: "Week-over-week change for each metric",
        state: "unmet",
      },
      {
        id: "k3",
        text: "Fits on one page",
        state: "partial",
        evidence: "Template ready",
      },
    ],
    plan: [
      { id: "p1", label: "Prepare the digest template", status: "done" },
      { id: "p2", label: "Export signups", status: "active" },
      { id: "p3", label: "Export activation", status: "todo" },
      { id: "p4", label: "Write the digest", status: "todo" },
    ],
    activity: [
      {
        id: "a1",
        time: "2026-11-01T10:02:00-08:00",
        text: "Export timed out — retry scheduled",
        tone: "danger",
      },
      {
        id: "a2",
        time: "2026-11-01T09:55:00-08:00",
        text: "Digest template prepared",
      },
    ],
    budget: { toolCalls: 6, toolLimit: 30, minutes: 9, minuteLimit: 30 },
    instructions: [],
    sources: [],
    updatedAt: "2026-11-01T10:02:00-08:00",
    createdAt: "2026-11-01T09:50:00-08:00",
  },
  {
    id: "g-tidy",
    title: "Tidy workspace",
    brief:
      "Sort loose files into folders, remove duplicates, and leave a short index.",
    status: "complete",
    progress: 100,
    currentStep: "Complete",
    conversationId: "c-workspace-old",
    criteria: [
      {
        id: "k1",
        text: "No loose files in the workspace root",
        state: "met",
        evidence: "23 files sorted into 5 folders",
      },
      {
        id: "k2",
        text: "Duplicates removed (snapshots kept)",
        state: "met",
        evidence: "6 duplicates · snapshot #14 kept",
      },
      {
        id: "k3",
        text: "Index file written",
        state: "met",
        evidence: "INDEX.md · 31 lines",
      },
    ],
    plan: [
      { id: "p1", label: "Snapshot the workspace", status: "done" },
      { id: "p2", label: "Sort files into folders", status: "done" },
      { id: "p3", label: "Remove duplicates", status: "done" },
      { id: "p4", label: "Write INDEX.md", status: "done" },
    ],
    activity: [
      {
        id: "a1",
        time: "2026-10-29T14:20:00-07:00",
        text: "Goal complete · all criteria met",
        tone: "healthy",
      },
      {
        id: "a2",
        time: "2026-10-29T14:12:00-07:00",
        text: "Removed 6 duplicates (snapshot kept)",
      },
    ],
    budget: { toolCalls: 31, toolLimit: 50, minutes: 12, minuteLimit: 30 },
    instructions: [],
    sources: [],
    updatedAt: "2026-10-29T14:20:00-07:00",
    createdAt: "2026-10-29T13:58:00-07:00",
  },
];

export const goalTemplates = [
  {
    id: "inbox",
    label: "Inbox cleanup",
    title: "Clean up newsletters",
    brief:
      "Find newsletters I haven’t opened in 60 days and prepare unsubscribe suggestions.",
    criteria: [
      "List every newsletter unopened for 60+ days",
      "No personal senders included",
      "Ask before unsubscribing",
    ],
  },
  {
    id: "research",
    label: "Research brief",
    title: "Research brief",
    brief: "A short, cited brief on a topic with a comparison table.",
    criteria: [
      "Every claim has a citation",
      "Compares at least three options",
      "Under 1,500 words",
    ],
  },
  {
    id: "report",
    label: "Weekly report",
    title: "Weekly status report",
    brief:
      "Summarize this week’s progress from my calendar, tasks and repo activity.",
    criteria: [
      "Covers Monday to Friday",
      "Lists blockers separately",
      "Draft only — never sent automatically",
    ],
  },
];
