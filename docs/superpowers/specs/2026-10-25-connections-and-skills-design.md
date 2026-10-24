# Milestone 1: connections and skills

Date: 2026-10-25
Status: design, not implemented
Base: `bab8534`, deploy `8d9022ed`

## Goal

Turn BLIP from an agent with five built-in tools into an agent that can use the outside world through MCP servers, first-party connectors and reusable skills.

Success means the owner can:

1. Add any remote MCP server over Streamable HTTP or SSE, with no code change.
2. Connect Gmail, Google Calendar, GitHub, Slack and similar services through OAuth.
3. See every connection, its tools, its scopes and its health in one place.
4. Turn individual tools on or off, and choose which tools need approval.
5. Install a Claude Code style skill, invoke it with a slash command or let the model choose it, and have its scripts run in the session sandbox.
6. Reload the page, keep every connection, and start a new chat without reconnecting.

## What already exists

The installed `agents` SDK already ships the hard part:

- `Agent.mcp: MCPClientManager`
- `addMcpServer(name, url, options)` for HTTP MCP servers
- OAuth continuation and callback support
- `discoverIfConnected(serverId)`
- `getAITools()` returning AI SDK tools
- `getMcpServers()`, `removeMcpServer()`
- elicitation handlers and per-server state persistence

This means milestone 1 is integration, not a new MCP client from scratch. See `node_modules/agents/dist/agent-routing-BMvWTFEp.d.ts` around `MCPClientManager`, `addMcpServer` and `getAITools`.

The current harness already accepts a per-session tool factory in `src/harness-config.ts`. The merge point is:

```ts
tools: (session) => ({
  ...buildTools(this.toolDeps(session)),
  ...this.mcp.getAITools(),
})
```

That simple merge is not enough on its own. Namespacing, approval policy, result limits, tool budget and UI all need work.

## Non-goals for milestone 1

- Local stdio MCP servers. A Worker cannot spawn a process. Those need a container bridge later.
- Every connector on earth on day one. The catalog starts with a small set and a custom server path.
- Full Claude Code plugin semantics such as hooks, marketplaces, sub-agent definitions and permission prompts.
- Automatic Gmail send on day one. Read-only Gmail access first, send only behind an approval card.
- Per-session credentials for multiple users. This is still a one-person deployment.

## Milestone 1 pillars

### A. MCP server registry

Add a Connections surface with an MCP server list.

Each server has:

- Name and stable id
- URL and transport (`streamable-http` default, `sse` fallback)
- Auth mode: none, bearer token, OAuth
- Enabled or disabled
- Connection state and last error
- Tool count and last discovery time
- Per-tool approval policy
- Optional preset id for a known connector

A custom server can be added with a URL and optional headers. The server is registered with `addMcpServer`, then discovered. The list comes from `getMcpServers()` plus our small settings table. Do not duplicate the SDK's persisted server rows.

Tool names must be namespaced and stable. Use `mcp__<server>__<tool>`, sanitized to the character set the router accepts. A collision is refused, not silently renamed.

Tool budget:

- Expose tools directly up to a measured cap, suggested 40 tools and 12,000 characters of descriptions.
- Above the cap, expose a `mcp` meta-tool with `list`, `search` and `call`.
- Never send 200 MCP tool schemas to the model. That spends the context before the first user turn.

Result handling:

- Truncate each tool result to a measured byte cap with an explicit notice.
- Strip images or files that the model cannot use unless an artifact path is returned.
- Map MCP progress notifications to the existing progress frames when the server sends them.
- Every MCP call gets a timeout and a visible failed card on error.

### B. OAuth and connectors

Two layers:

1. Generic MCP OAuth, handled by the SDK manager.
2. Curated connector presets that prefill the URL, auth mode, scopes, labels and read/write policy.

Initial connector catalog:

| Connector | Suggested first version | Write actions |
| --- | --- | --- |
| GitHub | Remote MCP or REST read tools | Push, merge, release behind approval |
| Gmail | Gmail API read-only, labels, search, read thread | Send and delete later, always approval |
| Google Calendar | List and read events | Create or delete event behind approval |
| Google Drive | List, search, read a file | Upload or delete behind approval |
| Slack | Read channels and history | Post message behind approval |
| Notion | Search and read pages | Create or update behind approval |

The connector broker question: services such as Pipedream Connect, Composio or Arcade can provide OAuth for hundreds of APIs. Use one only if the direct OAuth path for Gmail and GitHub becomes the bottleneck. A broker adds a third party that can see tokens and data, so it is a deliberate trust decision, not a shortcut.

Gmail is the risky one. Google marks Gmail scopes as sensitive. A personal OAuth client in testing can issue refresh tokens that expire, and publishing an unverified app has user caps and warnings. Before building the Gmail UI, measure token lifetime with the owner's account. If a long-lived personal token is not available, either complete Google verification or use a broker. Do not promise a permanent Gmail connection before that test.

Token storage:

- The SDK OAuth provider persists tokens in Durable Object storage. Verify whether it encrypts values at the application layer.
- If it does not, wrap token at rest with AES-GCM using a Worker secret, or store only an encrypted payload and let a small adapter refresh it.
- Never return a token to the browser.
- Disconnect must revoke the provider token when the provider supports revocation, then delete the local row.
- Log connect, refresh, disconnect and tool calls, never token values.

OAuth callback:

- One Worker route, for example `/api/mcp/oauth/callback`.
- State and PKCE validation stay inside the SDK provider. Do not invent a second state store.
- The callback page must be a small safe HTML page that posts a message to the console and closes. It must not echo callback parameters into the DOM.
- The browser bearer key is not part of the OAuth redirect.

Connector approval policy:

- Read-only tools run without asking.
- Tools that send, publish, pay, delete or change permissions ask.
- Trust MCP annotations as hints, never as truth. A server can lie. The server preset and a name-based classifier are the fallback.
- A global policy page lists every MCP tool with `free`, `ask` and `blocked`, and the policy is enforced in `toolApproval`.

### C. Skills

Native support for Claude Code style skills.

Skill format to support:

- Folder with `SKILL.md`
- YAML frontmatter: `name`, `description`
- Optional Claude fields: `allowed-tools`, `argument-hint`, `user-invocable`, `metadata`
- Markdown body with instructions
- Optional `references/`, `scripts/`, `assets/` folders

Import paths for milestone 1:

1. Upload a zip of a skill folder.
2. Import from a public Git URL or a subfolder in a repository.
3. Paste a `SKILL.md` for a text-only skill.

Claude Code marketplace support comes later. The parser and storage should already accept the same folder layout so marketplaces are a thin layer.

Discovery:

- Only skill name and description enter the system prompt by default.
- Cap the catalog block, suggested 50 skills and 6,000 characters.
- The full `SKILL.md` loads only when the skill is invoked.
- Reference files load only when the skill asks for them.

Invocation:

- User invocation: `/skill-name arguments` in the composer.
- Model invocation: a `skill` tool with `name` and `args`, allowed only for enabled skills.
- The tool returns the skill body plus a short note about available reference files and scripts.
- Arguments are substituted where the skill uses `$ARGUMENTS` or an equivalent placeholder. Document the rule once.

Scripts and files:

- On invocation, write the skill's files into `/home/user/.skills/<name>/` in the session sandbox.
- Scripts run through the existing `exec` tool, so the existing sandbox and approval rules apply.
- A skill with a script must show the file list and a warning at install time. Installing a skill is a trust decision.
- `allowed-tools` is parsed and enforced at the tool layer when practical. If enforcement is not possible in the first cut, show a clear warning and do not claim it is enforced.

Storage:

- Global skill library in the registry or a dedicated Durable Object.
- SQLite rows for metadata and body.
- Small asset files in Durable Object storage or the session workspace.
- Hard limits: 100 skills, 1 MB per text skill, 10 MB total assets. Refuse beyond the limit with a clear message.
- Version and source are stored so an update can be shown before replacing a skill.

Security:

- A skill is untrusted content. Treat its body as instructions from the owner only after install.
- Scan for obvious prompt-injection markers at install, but do not pretend the scan is a guarantee.
- Skills that require network writes still go through the MCP or exec approval rules.
- Deleting a skill does not delete the user's workspace files unless the skill lived only in `.skills`.

### D. Console UX

Add an **Extensions** page. Keep the existing Tools page as the built-in capability page.

Extensions has three tabs:

1. **Connectors**: Gmail, GitHub, Calendar, Drive, Slack, Notion. Each card shows connected state, account, scopes, tool count and Disconnect.
2. **MCP servers**: custom servers with Add server, Reconnect, Refresh tools, policy and Remove.
3. **Skills**: installed skills, source, version, enabled toggle, View files, Update, Remove. Add skill opens a dialog with Upload zip, Git URL or paste.

Composer:

- Typing `/` opens a command palette with user-invocable skills, plus existing commands.
- The selected skill is shown as a chip above the composer, not hidden in the text.
- The model can still choose a skill without the slash command.

Chat:

- MCP tool calls use a generic widget with the server mark, tool name, arguments summary and result status.
- Skill calls use a compact "Skill: name" card with a View instructions action.
- Write actions render the existing approval gate with the server, account and exact arguments.

Settings:

- A policy table for MCP tools: free, ask, blocked.
- A connection health panel with last error and a test button.
- A skills directory size and limit indicator.

## Data model

Prefer SDK-owned MCP rows. Add only what the SDK does not track.

```sql
connector_settings (
  server_id TEXT PRIMARY KEY,
  preset_id TEXT,
  label TEXT,
  policy_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  version TEXT,
  source TEXT,
  body TEXT NOT NULL,
  frontmatter TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

skill_files (
  skill_id TEXT NOT NULL,
  path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  content BLOB,
  PRIMARY KEY (skill_id, path)
);
```

Do not create an `oauth_tokens` table until the SDK storage is audited. If encryption is needed, use a narrow adapter rather than a second token store.

## API surface

MCP:

- `GET /api/extensions/mcp`
- `POST /api/extensions/mcp` add a server
- `PATCH /api/extensions/mcp/:id` enable, disable or policy
- `DELETE /api/extensions/mcp/:id`
- `POST /api/extensions/mcp/:id/connect`
- `POST /api/extensions/mcp/:id/discover`
- `GET /api/extensions/mcp/oauth/callback`

Skills:

- `GET /api/extensions/skills`
- `POST /api/extensions/skills/import`
- `PATCH /api/extensions/skills/:id`
- `DELETE /api/extensions/skills/:id`
- `GET /api/extensions/skills/:id/files`

All routes use the existing bearer gate. OAuth callback is the only route with its own state validation.

## Build order

### Phase 1: MCP core

1. Add the Extensions page shell and the MCP list endpoint.
2. Register one remote MCP server with no auth.
3. Merge `getAITools()` into the harness tool factory.
4. Namespace and cap tools. Add the generic widget and failure card.
5. Tests: tool merge, collision refusal, approval mapping, result truncation, connection loss.
6. Live: connect a public read-only MCP server, call a tool, reload and call again.

### Phase 2: OAuth and GitHub

1. Wire the SDK OAuth callback and store server metadata.
2. Connect GitHub through OAuth.
3. Read-only tools are free; write tools ask.
4. Audit token storage at rest and fix it before launch.
5. Tests: state mismatch, expired token, refresh, disconnect, cross-session access.
6. Live: list repositories, read a file, attempt a write without approval and observe the gate.

### Phase 3: Gmail read-only

1. Create the Google Cloud project and OAuth client.
2. Measure refresh token lifetime with the owner's account.
3. Implement list, search, read thread and attachment metadata.
4. Send stays out of scope until the approval flow and token lifetime are proven.
5. Live: find one message and read its body; no send.

### Phase 4: Skills core

1. Skill parser and storage.
2. Import from zip and Git URL.
3. Prompt catalog with name and description only.
4. `skill` tool and slash invocation.
5. Write skill files into the sandbox and run a script skill.
6. Tests: frontmatter, size limits, path traversal, duplicate names, prompt budget, disabled skills, allowed-tools parsing.
7. Live: install a small Claude Code skill, invoke it both ways, reload and invoke again.

### Phase 5: Catalog and polish

1. Add remaining presets.
2. Add per-tool policy UI and health checks.
3. Add skill update and uninstall.
4. Capture every state at 1440 and 390, light and dark.
5. Update cards, README and the live matrix.

## Acceptance tests

A milestone is not done until these are live:

1. Add a public MCP server, discover its tools, call one, restart the Worker, call it again.
2. Connect GitHub, list a repository, and see a write action park in the gate.
3. Connect Gmail read-only, search and read a message, with a measured token lifetime.
4. Install a Claude Code skill with a script, invoke it with `/name`, and watch the script run in the sandbox.
5. Disable a skill and prove the model can no longer call it.
6. Reload the console and keep every connection and skill.
7. Revoke a connector and prove a tool call fails with a clear reconnect card.
8. Hit the tool cap and prove the model is not sent the whole catalog.

## Risks and decisions

- **Gmail token lifetime** is the largest external risk. Test before building the UI.
- **Tool bloat** can silently degrade every turn. The cap and meta-tool must ship with the first MCP server.
- **MCP trust** is not like a local library. A remote server can change its tools and descriptions. Cache, diff and show changes.
- **Prompt injection** from tool results is expected. Tool output is data, not instructions. Approval stays at the tool boundary.
- **Skills are code and prompt.** Install is a trust decision. Sandbox execution is mandatory.
- **OAuth callback and tokens** need a dedicated security review before any live Gmail scope.
- **Connector broker** decision is deferred until direct OAuth is measured. Do not add a broker in phase 1.

## Later milestones, for context

- Workspace v2 and artifacts.
- Native attachments and previews.
- Message queue, drafts, full-text search.
- Multi-user accounts and per-user connector isolation.
- Local stdio MCP bridges in a container.
- Claude Code marketplace and plugin installs.
