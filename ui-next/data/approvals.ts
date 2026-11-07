import type { AffectedItem, Approval } from "../types";

const PROMO_SENDERS: [string, string][] = [
  ["Lumen Outdoor", "Final hours: 40% off trail gear"],
  ["Parcel & Pine", "Your weekend reading list is here"],
  ["Northline Air", "Fares to Lisbon from $389"],
  ["Brightside Coffee", "New roast drop — members first"],
  ["Kestrel Fitness", "Your October progress (and a deal)"],
  ["Atlas Home", "Fall refresh: up to 30% off"],
  ["Pixel Weekly", "This week’s top 10 gadgets"],
  ["Marlow Books", "Three new releases you might like"],
  ["Ferngrove Market", "Fresh picks for your next order"],
  ["Studio Hum", "Free shipping ends tonight"],
  ["Tidewater Co.", "Last chance: archive sale"],
];

export const promoThreads: AffectedItem[] = Array.from(
  { length: 41 },
  (_, i) => {
    const [sender, subject] = PROMO_SENDERS[i % PROMO_SENDERS.length];
    return {
      id: `t${i + 1}`,
      primary: sender,
      secondary: subject,
      meta: `Oct ${30 - (i % 27)}`,
    };
  },
);

export const seedApprovals: Approval[] = [
  {
    id: "a-promo",
    title: "Move 41 promotional threads to Trash",
    app: "Gmail",
    account: "maya@northwind.example",
    tool: "gmail.threads.trash",
    params:
      '{\n  "query": "category:promotions newer_than:30d -is:starred -from:contacts",\n  "threads": 41\n}',
    reversible: true,
    reversibleNote:
      "Reversible for 30 days — threads can be restored from Trash.",
    rationale:
      "You asked Blip to clear promotional mail from the last month and keep anything personal. These 41 threads come from retail and newsletter senders you have never replied to.",
    risk: "low",
    affectedLabel: "41 promotional threads",
    affected: promoThreads,
    excludedNote:
      "17 threads excluded: 9 from contacts, 5 starred, 3 receipts you replied to. No personal email is included.",
    changes: [
      { label: "Inbox", before: "128 threads", after: "87 threads" },
      { label: "Trash", before: "4 threads", after: "45 threads" },
      { label: "Auto-deletes", before: "—", after: "Dec 1, 2026" },
    ],
    editable: { kind: "items" },
    conversationId: "c-inbox",
    goalId: "g-promo",
    status: "pending",
    requestedAt: "2026-11-01T09:12:00-08:00",
  },
  {
    id: "a-weekly",
    title: "Send the weekly update to the design team",
    app: "Gmail",
    account: "maya@northwind.example",
    tool: "gmail.messages.send",
    params:
      '{\n  "to": "design-team@northwind.example",\n  "subject": "Weekly update · Oct 26–30"\n}',
    reversible: false,
    reversibleNote: "Irreversible — a sent email can’t be unsent.",
    rationale:
      "Your Friday routine drafts this update from your calendar and tasks. Sending goes to 6 people outside this chat, so Blip always asks first.",
    risk: "medium",
    affectedLabel: "6 recipients",
    affected: [
      {
        id: "r1",
        primary: "Priya Raman",
        secondary: "priya@northwind.example",
        meta: "via list",
      },
      {
        id: "r2",
        primary: "Jonas Weber",
        secondary: "jonas@northwind.example",
        meta: "via list",
      },
      {
        id: "r3",
        primary: "Ama Owusu",
        secondary: "ama@northwind.example",
        meta: "via list",
      },
      {
        id: "r4",
        primary: "Leo Martins",
        secondary: "leo@northwind.example",
        meta: "via list",
      },
      {
        id: "r5",
        primary: "Hana Sato",
        secondary: "hana@northwind.example",
        meta: "via list",
      },
      {
        id: "r6",
        primary: "Sam Ortiz",
        secondary: "sam@northwind.example",
        meta: "via list",
      },
    ],
    changes: [
      { label: "Recipients", before: "—", after: "design-team@ (6 people)" },
      { label: "Sent folder", before: "—", after: "+1 message" },
    ],
    editable: {
      kind: "text",
      label: "Message",
      value:
        "Hi all,\n\nQuick update for Oct 26–30:\n• Onboarding flow v3 is ready for review.\n• Icon set handed off to engineering.\n• Next week: usability sessions Tue & Thu.\n\nThanks,\nMaya",
    },
    conversationId: "c-brief",
    status: "pending",
    requestedAt: "2026-10-30T16:02:00-07:00",
  },
  {
    id: "a-focus",
    title: "Add a focus block on Thursday",
    app: "Calendar",
    account: "maya@northwind.example",
    tool: "calendar.events.create",
    params:
      '{\n  "title": "Focus · onboarding review",\n  "start": "2026-10-29T09:00",\n  "end": "2026-10-29T11:00"\n}',
    reversible: true,
    reversibleNote: "Reversible — the event can be deleted at any time.",
    rationale: "You asked Blip to protect two hours for the onboarding review.",
    risk: "low",
    affectedLabel: "1 calendar event",
    affected: [
      {
        id: "ev1",
        primary: "Focus · onboarding review",
        secondary: "Thu, Oct 29 · 9:00–11:00 AM PDT",
        meta: "Work calendar",
      },
    ],
    changes: [{ label: "Thursday", before: "3 events", after: "4 events" }],
    conversationId: null,
    status: "approved",
    requestedAt: "2026-10-28T17:40:00-07:00",
    resolvedAt: "2026-10-28T17:42:00-07:00",
    receiptId: "RCPT-3C9E",
  },
];
