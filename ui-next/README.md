# BLIP — a little less busy

A complete frontend rethink of the BLIP Quiet Console reference gallery. Built around outcomes, transparent work, and a familiar little companion.

## Open it immediately

1. Extract the ZIP.
2. Double-click **OPEN_ME.html**.

This self-contained preview includes the app, fonts, and all 20 mascot states. No npm install, server, CDN, AI key, or app connection is needed. Use a current Chrome, Edge, Firefox, or Safari browser. If your browser restricts file-origin storage, the app still works in memory; use the served version below for dependable persistence.

**This is an interactive frontend demo, not the actual autonomous agent backend.** All agent runs, tool outputs, accounts, approval receipts, schedules, and MCP states are explicitly simulated. Local file uploads, previews, downloads, editing, navigation, settings, and browser read-aloud are real local interactions. No real email is sent, no real shell command is executed, no real OAuth flow runs, and no real app is connected. Do not paste credentials into the demo.

## Develop it

Use Node.js 20.19+ (Node 22/24 LTS recommended):

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. Other commands:

```sh
npm run typecheck
npm run build
npm run preview
```

`dist/` is a ready-to-serve static production build. The default dev and preview servers bind to localhost. `OPEN_ME.html` is a bundled, offline snapshot of the same release; rebuild the source when changing it.

## What changed

- **Overview:** task-first hero, an integrated companion, attention strip, active goals, next-up routines, and outcome timeline.
- **Conversations:** searchable/pinned threads, deterministic planning -> research -> tool -> verification timeline, expandable diagnostics, queued follow-ups, attachments, contextual files/plan, retry and offline states.
- **Approvals:** a dedicated decision workspace with the exact tool/account, affected items, change preview, rationale, reversibility, approve-once/deny, and demo receipts.
- **Goals:** list/board display, filters, goal templates, measurable criteria, tool/time budgets, evidence, instructions, pause/resume and guarded cancellation.
- **Automations:** schedules, page watchers and webhook configurations in one place, IANA timezones, next-window previews, run history, missing-chat recovery and guarded removal.
- **Library:** created outputs and uploaded files together, useful previews, sandboxed HTML, original-byte downloads and transparent transcript-only audio fixtures.
- **Connections:** multiple mock accounts, scoped permissions, per-app health, guided demo connect/reconnect, and MCP configuration without collecting secrets.
- **Capabilities:** searchable product abilities, prerequisites and safety boundaries.
- **Memory & skills:** explicit human-readable memories with editing and guarded cleanup; inspectable/downloadable instruction packs.
- **Settings:** light/dark/system themes, motion preferences, model/provider metadata, safety explanation, local data export and typed-confirmation reset.
- **Motion lab:** every original state, replay/pause/speed, static reduced-motion previews, and a work-cycle sequence.

## The same mascot, smoother behavior

The actual original black disk, white-eye geometry and all **20 original pose functions** are retained in `utils/mascot-poses.js`. The character was not replaced with a different robot/blob illustration. The new runtime adds 380 ms geometric state blending, one-shot reactions that settle, a continuous loading spinner/crossfade, shared requestAnimationFrame scheduling, responsive DPR-capped rendering, offscreen/background suspension and meaningful static reduced-motion poses.

States: `listening`, `reading`, `writing`, `editing`, `searching`, `running`, `approval`, `unsure`, `done`, `oops`, `replying`, `sleeping`, `idle`, `waking`, `thinking`, `curious`, `alert`, `deep-focus`, `offline`, `loading`.

## Good places to start

1. Open Overview and give Blip a short task to watch a simulated run.
2. Open Approvals and inspect an exact action before approving or denying it.
3. Create a goal and read its criteria, plan and evidence separately.
4. Upload a small Markdown/image file to Library and download the original bytes.
5. Open Motion lab and switch expressions, replay the work cycle, then enable reduced motion.
6. Try Ctrl/Cmd+K, the mobile More drawer, and the dark theme.

## Files worth reading

- `docs/SCREEN_AUDIT.md`: all 31 original reference screens reviewed and mapped to redesign decisions.
- `docs/BACKEND_INTEGRATION.md`: the real integration boundary, proposed APIs, event contract and server-enforced safety requirements.
- `docs/QA_REPORT.md`: build and browser verification scope.
- `docs/SOURCE_PROVENANCE.md`: original character references and font licensing.
- `previews/`: desktop/mobile screenshots and an offline image gallery.
- `contexts/AppContext.tsx`: state, themes, navigation and browser persistence.
- `contexts/RunContext.tsx`: explicitly simulated run adapter; replace it with the actual event stream.
- `types/index.ts`: display contracts for tasks, goals, approvals, outputs and integrations.

## Honest limitations

- The supplied repository is a reference gallery, not the production agent source. No real backend integration can be inferred from screenshots alone.
- Local uploads are limited to 1 MB per file and approximately 3.5 MB of demo library data. Browser storage is not a secure vault. Export before resetting or clearing site data.
- Most fixtures include real text/code for preview/download. The sample morning audio is a transcript, not a fabricated MP3 binary. Browser read-aloud uses your browser's available voices.
- HTML previews use an isolated sandbox with network/form/parent access blocked. Uploaded instructions/skills are never executed by this frontend.
- This is not a complete security audit, WCAG certification, or a substitute for testing against your production agent.
- No branch, commit, pull request or deployment was created in your original repository.
