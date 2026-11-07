# Backend integration contract

This is a frontend redesign and local interactive demonstration, not an autonomous-agent service. No Gmail/Calendar/GitHub action, OAuth flow, shell command, web search, model call or real verification is performed. Demo app accounts and fixture files are not connected to your real Composio accounts.

## Replace the adapter boundary, not the design

- `contexts/AppContext.tsx` provides state and navigation. Replace persisted fixture reads with authenticated queries to your existing agent backend.
- `contexts/RunContext.tsx` is the deterministic demo-run simulator. Replace its timers with the real run event stream (SSE or WebSocket). Keep a stable run ID, message ID, sequence number and reconnect cursor. Do not continue the demo timers in production.
- `types/index.ts` defines display contracts for Conversation, AgentEvent, Goal, Approval, Automation, LibraryItem, Connection, Memory and Skill.
- `utils/mascot-runtime.ts` renders visual state only. It is not a source of execution truth. Map authoritative run events to character states; never let an animation imply an operation completed.

## Suggested API surfaces

| Domain             | Suggested routes                                                                    | Required behavior                                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Conversations      | GET/POST `/api/conversations`, POST `/:id/messages`, GET `/:id/events?after=cursor` | Persist task before starting. Preserve drafts on errors. Resume streams using sequence IDs.                                                                                                      |
| Runs               | GET `/api/runs/:id`, POST `/:id/pause`, POST `/:id/cancel`                          | Distinguish cooperative pause from immediate cancellation. Cancellation does not magically undo side effects.                                                                                    |
| Approvals          | GET `/api/approvals`, POST `/:id/decision`                                          | Validate user identity, ownership, pending state, exact canonical action hash, scope, tool, account and expiry on server. Use idempotency key. Any edited recipient/items requires revalidation. |
| Goals              | CRUD `/api/goals`, GET `/:id/evidence`, POST `/:id/instructions`                    | Version the plan and cite actual evidence. Enforce budget limits server-side.                                                                                                                    |
| Automations        | CRUD `/api/automations`, GET `/:id/runs`                                            | Store IANA timezone + schedule rule, handle DST, deduplicate webhook events, validate URLs and rate limits.                                                                                      |
| Library            | GET `/api/files`, GET `/:id/preview`, GET `/:id/download`                           | Use authenticated, scoped file access and signed download URLs. Enforce MIME/size limits. Never execute uploaded HTML in the parent origin.                                                      |
| Connections        | GET `/api/connections`, POST `/:id/connect`, POST `/:id/disconnect`                 | Real OAuth starts and callback validation happen on the backend. Request least privilege, track expiry per account, never expose refresh tokens.                                                 |
| Memory/skills      | CRUD `/api/memories`, CRUD `/api/skills`                                            | Explicit edit/delete controls, provenance, audit trail. Skills cannot bypass approval policies.                                                                                                  |
| Settings/providers | GET/PATCH `/api/settings`, POST `/api/providers`                                    | Secrets must go to an encrypted server-side vault. Never localStorage. Redact secrets in errors and logs.                                                                                        |

## Safety requirements

1. Authentication and authorization are server-enforced. UI state and localStorage are untrusted.
2. An approval must authorize one exact action, not a mutable prompt. A decision receipt is returned only after actual execution outcome is known.
3. Duplicate approval clicks, run retries and reconnects must not execute an action twice. Use idempotency and transactional state transitions.
4. Offline does not mean stopped. On reconnect, query actual run and approval status before offering retry.
5. Delete operations should surface linked goals/automations and support reassignment or cascade decisions with concrete impact previews.
6. Token values never appear in a client response, export, app log or analytics event.
7. Keep uploaded HTML sandboxed. Avoid `allow-same-origin` together with `allow-scripts`. Sanitize rendered Markdown and validate outbound URLs.
8. Demo approvals and settings are not production guarantees. Server-side policies remain authoritative.

## Event envelope example

```ts
type RunEvent = {
  id: string;
  runId: string;
  sequence: number;
  occurredAt: string;
  type:
    | "run.started"
    | "step.started"
    | "tool.output"
    | "approval.requested"
    | "approval.resolved"
    | "artifact.created"
    | "run.completed"
    | "run.failed";
  payload: unknown;
};
```

Derive plan progress from authoritative events, not elapsed time. Retain detailed diagnostic output under progressive disclosure; surface the human-readable outcome first. Test auth expiry, partial success, a tool failing after another succeeded, denied/expired approval, reconnect during approval, cancellation during side effects, and conflicting updates from another tab.
