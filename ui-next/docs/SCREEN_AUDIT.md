# BLIP redesign: screen-by-screen audit

## Scope and evidence

Reviewed the complete manifest (31 PNGs, including 6 phone captures), gallery HTML, 80-frame mascot sheet and the actual canvas animation source. The repository is a design-reference gallery, not the application/backend source. Findings below concern the visible reference states, not unobserved production behavior.

Reference: https://github.com/ZayFE7/blip-design-gallery
Tree snapshot: `ba72bb60ced20cbd744e9ffbd3f2f1095b96c6b1` (retrieved main).

## New product model

- Overview answers what is running, what needs a decision, and what has changed.
- Conversation is the collaboration surface; run history is structured evidence, not noise.
- Approvals are deliberate, scoped decisions with action previews.
- Goals express outcomes, plans and evidence; Automations express triggers and repeatable work.
- Library unifies user files and created artifacts without erasing their origin.
- Connections, Capabilities, Memory & Skills and Settings are distinct responsibilities.
- Motion communicates state and causality, and has a first-class reduced-motion path.

## Complete reference coverage

| Reference                                                                                                                      | Visible issue / opportunity                                                             | Rebuild direction                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [Welcome](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-empty.png)                                        | Generic capability starters do not reveal the value of autonomy.                        | Outcome-first Overview, clear task composer, helpful starters and a visible agent state.               |
| [Populated transcript](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-chat.png)                            | Mixed calendar, email and shell work lacks a distinct run structure.                    | Readable transcript plus an inspectable execution timeline and contextual outputs.                     |
| [Streaming, queue and attachment](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-chat-live.png)            | Queue, attachment and step status compete for a narrow composer region.                 | Explicit run progress, stoppable simulation, attachment chips and a named follow-up queue.             |
| [Tool output expanded](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-chat-tool-open.png)                  | Expanded tool evidence lives inline without a consistent diagnostic hierarchy.          | Collapsible event records with input, output, result and retry affordances.                            |
| [Approval gate](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-chat-approval.png)                          | Generic approval wording explains risk but not the exact proposed side effect.          | First-class action preview: tool, account, affected items, scope, reversibility and approve-once/deny. |
| [Sidebar message search](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-search.png)                        | Search and a connection-loss state are coupled in the captured screen.                  | Global command search and conversation search; contextual offline/reconnect presentation.              |
| [Dark mode](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-chat-dark.png)                                  | Dark mode retains the same dense transcript structure.                                  | Token-based full dark theme with legible nested surfaces and contrast-preserving mascot stages.        |
| [Goals](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-goals.png)                                          | Goals mix attention blockers with a long flat list.                                     | Clear status filters, progress-led work items and separate attention states.                           |
| [Goal detail](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-goal-detail.png)                              | Budgets, brief, approvals and events are present but the plan is not the visual spine.  | Outcome -> plan -> evidence -> activity; clear budgets and controlled pause/cancel semantics.          |
| [Automations](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-automations.png)                              | Triggers and scheduled jobs form two overlapping concepts.                              | One Automations space with schedule, watcher and webhook trigger types.                                |
| [Automation detail](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-automation-detail.png)                  | Source, instructions and events are text-heavy.                                         | A readable When -> Check -> Do flow with timezone, next run and run history.                           |
| [Files](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-files.png)                                          | File list and artifact browsing require separate mental models.                         | A unified Library with origin/type filters and useful previews.                                        |
| [Artifacts](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-artifacts.png)                                  | Artifact cards provide little visual evidence of the output.                            | Real text/code/document previews and safe downloadable demo content.                                   |
| [Connections](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-connections.png)                              | Connection information is long, account-heavy and inconsistent across app groups.       | Consistent per-app account, scopes, health and manage actions.                                         |
| [Connections: MCP and Google setup](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-connections-bottom.png) | MCP and managed OAuth explanations are buried far down the page.                        | MCP is a clear connection section; technical details are disclosed on demand.                          |
| [Capabilities](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-tools.png)                                   | Flat capability list does not foreground prerequisites or safety boundaries.            | Searchable grouped capabilities with availability and setup routes.                                    |
| [Settings](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-settings.png)                                    | Model setup, connections, memory and capability links share one long surface.           | Focused settings sections; Memory & Skills become a first-class destination.                           |
| [Settings: memory and skills](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-settings-bottom.png)          | Important memories and installed skills are low in the settings scroll.                 | Searchable Memory & Skills workspace with readable provenance and guarded deletion.                    |
| [Goals, dark mode](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-dark-goals.png)                          | A global Failed header can conflict with independently healthy goal statuses.           | Local error states and a global demo health indicator rather than blanket failure.                     |
| [New goal dialog](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-dialog-goal.png)                          | Success criteria are valuable but a large form needs a more guided structure.           | Template-assisted goal creation with explicit objective, evidence and budgets.                         |
| [Add provider dialog](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-dialog-provider.png)                  | Provider forms invite secrets; this gallery cannot establish server-side storage.       | Demo provider metadata only; production secrets belong in a backend vault, never localStorage.         |
| [Delete all chats confirmation](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-delete-all-dialog.png)      | Deletion warns about broken goal/automation references but needs impact-aware handling. | Typed confirmation, explicit scope and local-only reset; cancel is the default safe path.              |
| [Empty after cleanup](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-after-delete.png)                     | The reset state returns to a generic empty chat.                                        | Deliberate empty state with a useful next step and preserved navigation.                               |
| [Mascot card](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-mascot-card.png)                              | The mascot is an isolated status card rather than part of the work model.               | An integrated companion with semantic state labels, contextual task status and a full motion lab.      |
| [Mascot card: greeting](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-mascot-hi.png)                      | Greeting animation is isolated from the larger state lifecycle.                         | Purposeful greeting -> listening -> working -> result transitions using the same character.            |
| [Chat](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-mobile-chat.png)                                     | Long transcripts leave little room for composer and contextual controls.                | Mobile-sized transcript, sticky composer and contextual information in sheets.                         |
| [Sidebar drawer](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-mobile-drawer.png)                         | All product navigation is dependent on a large sidebar drawer.                          | Persistent bottom primary navigation plus an accessible More drawer.                                   |
| [Goals](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-mobile-goals.png)                                   | Introductory prose pushes actionable goals lower on a small screen.                     | Short headings, concise summaries, filter controls and readable goal cards.                            |
| [Welcome](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-mobile-empty.png)                                 | Stacked starter cards consume the first mobile viewport.                                | A compact task-first hero with progressive starter discovery.                                          |
| [Approval gate](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-mobile-approval.png)                        | Approval inherits a long inline transcript and cramped actions.                         | A focused decision surface with exact action details and large safe controls.                          |
| [Mascot card](https://github.com/ZayFE7/blip-design-gallery/blob/main/screens/ui-mobile-mascot.png)                            | The companion overlay can consume most of the phone view.                               | Responsive companion presentation with meaningful status and non-blocking dismissal.                   |

## Character identity and motion audit

The original character is a black circular disk with two white round-capped stroke eyes. The exact original geometry and all 20 pose functions are retained in `mascot-poses.js`; this is not a new blob/robot illustration. Original blink timing, curved happy eyes, search saccades, asymmetric expressions and body squash remain recognizable.

Improvements in the new runtime:

- Shared requestAnimationFrame scheduler instead of a React render per animation frame.
- Critically damped-style 380 ms pose blending when changing state; interpolates the actual eye/body geometry.
- One-shot actions play once and settle, rather than repeating applause or repeated approval hops indefinitely.
- Waking ends awake; it no longer drifts back to sleep during a wake transition.
- Loading crossfades the original disk and spinner rather than abruptly replacing the character.
- Transparent stages, DPR capped at 2, responsive canvas sizing.
- Offscreen canvases and background tabs do not keep running animation loops.
- OS reduced motion and explicit app preference show intentionally chosen static poses.
- State labels communicate status without relying on motion or color alone.

### Original 20 states preserved

- `listening`
- `reading`
- `writing`
- `editing`
- `searching`
- `running`
- `approval`
- `unsure`
- `done`
- `oops`
- `replying`
- `sleeping`
- `idle`
- `waking`
- `thinking`
- `curious`
- `alert`
- `deep-focus`
- `offline`
- `loading`

## Product improvements beyond the references

1. Attention is a queue, not a flashing global error.
2. Output provenance links work back to its task.
3. Consent distinguishes a proposed side effect from execution evidence.
4. Failures offer a local remedy and preserve user input.
5. Keyboard navigation, dialog focus management and mobile primary navigation are part of the interaction design.
6. Frontend simulations are explicitly marked; no mock action is represented as a real email sent or real OAuth connection.

## Important integration boundary

This deliverable is a standalone frontend redesign. It does not contain the real autonomous agent runtime, real OAuth/token handling, email access, filesystem execution, TTS service, or server-side verification. See BACKEND_INTEGRATION.md for the contract and safety boundary.
