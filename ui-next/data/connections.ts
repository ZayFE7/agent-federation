import type { AppConnection, McpServer } from "../types";

export const seedConnections: AppConnection[] = [
  {
    id: "gmail",
    name: "Gmail",
    icon: "gmail",
    category: "Communication",
    description:
      "Search, read, draft and — with your approval — send or trash email.",
    connected: true,
    accounts: [
      {
        id: "acc-g1",
        email: "maya@northwind.example",
        label: "Work",
        state: "synced",
        lastSync: "2026-11-01T10:20:00-08:00",
      },
    ],
    scopes: [
      {
        id: "read",
        label: "Read mail",
        description: "Search and read messages and threads.",
        enabled: true,
        required: true,
      },
      {
        id: "draft",
        label: "Create drafts",
        description: "Write drafts that stay in your Drafts folder.",
        enabled: true,
      },
      {
        id: "send",
        label: "Send mail",
        description: "Send email — always asks for approval first.",
        enabled: true,
        sensitive: true,
      },
      {
        id: "trash",
        label: "Move to Trash",
        description: "Move threads to Trash — always asks first.",
        enabled: true,
        sensitive: true,
      },
    ],
  },
  {
    id: "calendar",
    name: "Calendar",
    icon: "calendar",
    category: "Planning",
    description: "Read your schedule and propose or create events.",
    connected: true,
    accounts: [
      {
        id: "acc-c1",
        email: "maya@northwind.example",
        label: "Work",
        state: "synced",
        lastSync: "2026-11-01T10:18:00-08:00",
      },
      {
        id: "acc-c2",
        email: "maya.chen@home.example",
        label: "Personal",
        state: "syncing",
        lastSync: "2026-11-01T09:40:00-08:00",
      },
    ],
    scopes: [
      {
        id: "read",
        label: "Read events",
        description: "See event titles, times and attendees.",
        enabled: true,
        required: true,
      },
      {
        id: "write",
        label: "Create & edit events",
        description: "Add holds and focus blocks — asks first.",
        enabled: true,
        sensitive: true,
      },
    ],
  },
  {
    id: "tasks",
    name: "Tasks",
    icon: "tasks",
    category: "Planning",
    description: "Read and update your task lists.",
    connected: true,
    accounts: [
      {
        id: "acc-t1",
        email: "maya@northwind.example",
        state: "synced",
        lastSync: "2026-11-01T10:12:00-08:00",
      },
    ],
    scopes: [
      {
        id: "read",
        label: "Read tasks",
        description: "See lists, due dates and notes.",
        enabled: true,
        required: true,
      },
      {
        id: "write",
        label: "Create & complete tasks",
        description: "Add tasks and mark them done.",
        enabled: true,
      },
    ],
  },
  {
    id: "github",
    name: "GitHub",
    icon: "github",
    category: "Development",
    description:
      "Read repositories, open pull requests and receive push events.",
    connected: true,
    accounts: [
      {
        id: "acc-gh1",
        email: "mayachen (personal)",
        state: "expired",
        lastSync: "2026-10-31T11:14:00-07:00",
      },
    ],
    scopes: [
      {
        id: "repo-read",
        label: "Read repositories",
        description: "Browse code, issues and pull requests.",
        enabled: true,
        required: true,
      },
      {
        id: "pr",
        label: "Open pull requests",
        description: "Push branches and open PRs for review.",
        enabled: true,
        sensitive: true,
      },
      {
        id: "hooks",
        label: "Receive webhooks",
        description: "Get notified about pushes to watched repos.",
        enabled: true,
      },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    icon: "slack",
    category: "Communication",
    description: "Summarize channels and draft messages for review.",
    connected: false,
    accounts: [],
    scopes: [
      {
        id: "read",
        label: "Read channels",
        description: "Read messages in channels you choose.",
        enabled: true,
        required: true,
      },
      {
        id: "post",
        label: "Post messages",
        description: "Post as you — always asks first.",
        enabled: false,
        sensitive: true,
      },
    ],
  },
  {
    id: "drive",
    name: "Drive",
    icon: "drive",
    category: "Files",
    description: "Find documents and save Blip’s work to folders.",
    connected: false,
    accounts: [],
    scopes: [
      {
        id: "read",
        label: "Read files you pick",
        description: "Only files you explicitly share with Blip.",
        enabled: true,
        required: true,
      },
      {
        id: "write",
        label: "Save new files",
        description: "Create files in a Blip folder.",
        enabled: true,
      },
    ],
  },
  {
    id: "dropbox",
    name: "Dropbox",
    icon: "dropbox",
    category: "Files",
    description: "Read and organize files in a chosen folder.",
    connected: false,
    accounts: [],
    scopes: [
      {
        id: "read",
        label: "Read a folder",
        description: "Access one folder you choose.",
        enabled: true,
        required: true,
      },
    ],
  },
  {
    id: "figma",
    name: "Figma",
    icon: "figma",
    category: "Design",
    description: "Read files and comments to write design summaries.",
    connected: false,
    accounts: [],
    scopes: [
      {
        id: "read",
        label: "Read files & comments",
        description: "View files you have access to.",
        enabled: true,
        required: true,
      },
    ],
  },
];

export const seedMcpServers: McpServer[] = [
  {
    id: "mcp-linear",
    name: "Linear",
    url: "https://mcp.linear.example/sse",
    auth: "oauth",
    tools: 18,
    status: "online",
    addedAt: "2026-10-12T10:00:00-07:00",
  },
  {
    id: "mcp-notion",
    name: "Notion",
    url: "https://mcp.notion.example/v1",
    auth: "oauth",
    tools: 12,
    status: "degraded",
    note: "2 tools failed their schema check and are hidden.",
    addedAt: "2026-10-20T10:00:00-07:00",
  },
];
