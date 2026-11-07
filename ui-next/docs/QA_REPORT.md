# Validation report

## Build

- TypeScript strict typecheck passed.
- Vite production build passed.
- Single JavaScript bundle approximately 604 KB uncompressed / 183 KB gzip. Single-bundle output is deliberate for the no-install HTML preview.
- Fonts are bundled locally with their license notices; default browsing made no external network requests in the checked routes.

## Responsive route smoke checks

All 11 screens were rendered at **1440×1000** and **390×844** in Chromium. The final pass recorded no runtime exceptions, crashed views or horizontal document overflow across those 22 route/viewport combinations. The checked initial views had accessible names for their rendered buttons. Dark Overview was captured at both widths.

Machine-readable results: `route-checks.json`.

## Interaction checks

Verified locally in Chromium:

- Navigation away from an active conversation, including the exit-transition edge case.
- Goal creation, detail display, persistence across reload, and pause/resume state.
- Routine creation, timezone-aware schedule preview and pause state.
- Memory creation/editing, persistence, guarded clear-all and Escape dismissal (staged final verification).
- Local Markdown upload, preview and download with exact original bytes.
- Exact-action approval, a retained receipt after queue updates, and denial with a reason.
- Deterministic demo task progression and created-output record.
- Ctrl+K keyboard navigation, with navigation matches prioritized over creating a new task.
- All 20 mascot state controls and unchanged canvas output while reduced motion is enabled.
- Light/dark theme switching and visible original black-disk character on dark stages.
- Mobile More drawer, Escape dismissal, and narrow viewport sizing.
- `OPEN_ME.html` opened and navigated directly via `file://` without an install/server.

These are targeted smoke checks, not an exhaustive regression suite or security/accessibility certification. Earlier checks caught a conversation-exit redirect race, intrinsic mobile grid sizing, modal-close lifecycle/focus timing, palette ranking, and approval receipt selection. The final source includes corrections for those findings.
