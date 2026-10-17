# BLIP console UI/UX — exploration report

Read-only analysis of the single-file console (`ui/index.html`, 398 lines) against the worker
(`src/index.ts`, 308 lines), the shared contract (`src/types.ts`, 77 lines), and supporting
backend files (`src/agent.ts`, `src/memory.ts`, `src/vault.ts`, `src/guardrails.ts`,
`wrangler.jsonc`). No source file was modified; this is research + planning only.

## Scope

- What the console actually renders today: dock/rail tabs, mascot state machine, chat renderer,
  tool cards, approve flow, tasks/plan polling.
- Which tabs are backed by real data vs. hardcoded placeholders (Docs, Ideas).
- UX defects: streaming, error/loading/empty states, cron-result surfacing, accessibility,
  keyboard, mobile, reconnection, notifications.
- Browser security/privacy: where the API key lives, XSS surface of the new `md()` renderer.
- A prioritized list of near-term improvements and next features with effort estimates.

Out of scope: sandbox internals, router lanes, guardrails tuning, memory/vector quality
(covered by sibling exploration docs).

## Feature map

Tab | Backed by | Real or placeholder
--- | --- | ---
Chat (`ui/index.html:358`) | `LOG` array in memory + `POST /api/message` (`ui/index.html:385`, `src/index.ts:59-77`); markdown via `md()` (`ui/index.html:327-343`); tool cards via `toolCard()` (`ui/index.html:357`) | **Real**, but history is browser-memory-only (no persistence across refresh; server has a `messages` table at `src/memory.ts:56-62`, `recentMessages()` at `src/memory.ts:144` but no HTTP endpoint exposes it)
Tasks (`ui/index.html:359-364`) | `GET /api/tasks` → DO `jobList()` → SQLite `tasks` (`src/index.ts:79-86`, `src/agent.ts:260-262`); plan checklist from `GET /api/plan` (`src/index.ts:88-95`) | **Real** for job list + plan; **honest gaps**: no job output/results, fake 60% progress bar (`ui/index.html:360`), no per-job detail
Docs (`ui/index.html:365`) | Nothing — hardcoded "Nothing yet" empty state | **Placeholder / dead tab.** `/internal/vault/*` (`src/index.ts:195-287`, `src/vault.ts`) is 9router container state sync (persisting `data.sqlite`), *not* user documents; `save_workspace` (`src/agent.ts:658,822-827`) snapshots the sandbox `/workspace` but nothing is surfaced in this tab
Ideas (`ui/index.html:366`) | Nothing — hardcoded "No ideas yet" empty state | **Placeholder / dead tab.** Nothing anywhere writes "ideas"; closest real substrate is the `memories` table (`src/memory.ts:48-55,111`) which is invisible to the UI
Tools (`ui/index.html:367-368`) | Hardcoded static list of 6 rows | **Semi-placeholder.** The toggles (`ui/index.html:368`) have no event handler — flipping them changes nothing server-side; disabled ones (Browser, Wallet) are honest copy

Chrome/features outside the tabs:

Feature | Backed by | Real or placeholder
--- | --- | ---
Mascot state machine | `PS` pose table (`ui/index.html:217-241`), `S` state map (`ui/index.html:296-307,310-321`), `pose()` (`ui/index.html:352-354`); state now comes deterministically from `AgentReply.state` (`src/types.ts:30-33`, used at `ui/index.html:385,388`) | **Real.** Note: the old LLM "decide" endpoint `POST /api/decide` (`src/index.ts:115-193`) is **no longer called by the UI** — it is legacy/debug (contains a `__debug_url` branch, `src/index.ts:128-139`)
Inspector ("Live activity" + "While you were away") | `insp()` (`ui/index.html:355`) built from `S[cur]`, `card()` and `LG` (last-4 done tasks, filled in `loadTasks()` `ui/index.html:386`) | Real, but away-timeline is task *titles only* — cron replies go to the server `messages` table (`src/agent.ts:356`) the UI never reads
Approve card + Deny/Approve | `card()` (`ui/index.html:308-309`), `decide()` → `POST /api/approve` (`ui/index.html:388`, `src/index.ts:97-113`, `src/agent.ts:277-309`); `loadPlan()` rehydrates a held action on boot (`ui/index.html:387`) | **Real end-to-end** — but only polled on startup and after a chat; no live push
Sidebar chat list | `TH=[["Main chat",...]]` (`ui/index.html:346`), `row/lst/sideHTML` (`ui/index.html:369-371`), `pick()` (`ui/index.html:380`), `newChat()` (`ui/index.html:381`) | **Facade.** Single server conversation (`chat(content)` takes no thread id, `src/agent.ts:218`); `pick()`/`newChat()` wipe `LOG` client-side only — "side chats" are fake and switching loses the visible transcript
Voice (mic) and attach (plus) buttons | markup `ui/index.html:213` | **Dead controls** — no handlers; S-state copy is honest ("Voice not connected yet", `ui/index.html:312`)
Run-count pill in header | `ui/index.html:211`, updated in `loadTasks()` (`ui/index.html:386`) and `schedule_task` increments (`ui/index.html:385`) | Real but stale between polls
WebSocket | Server fully supports it: upgrade gate `src/index.ts:42-53`, frames `{type:"chat"|"status"}` `src/agent.ts:311-340` | **Unused by the UI** — zero `WebSocket`/`wss:` references in `ui/index.html`; everything is one-shot `fetch`

## Current behavior (file:line)

**Startup.** `render(); loadTasks(); loadPlan();` (`ui/index.html:397`). One boot poll of
tasks/plan; after that, refresh happens only inside `fedChat()` (`ui/index.html:385`) when the
user sends a message. There is no interval, no WebSocket, no visibility-change refetch.

**Sending a message.** `send()` (`ui/index.html:384`): trims input, and *if no key is in
localStorage*, prompts with `prompt("Agent API key (stored in this browser only):")` and stores
it as `localStorage["blip_key"]` (line 384). Pushes `["u",text]` into `LOG`, sets `cur="think"`,
`busy=true`, renders, then `fedChat()` (`ui/index.html:385`) POSTs
`{content, tier:"primary"}` (hardcoded) with `authorization: Bearer <localStorage key>` to
`https://agent-federation.agent-federation.workers.dev/api/message` (`AGENT` const,
`ui/index.html:325`). On the JSON response it pushes the reply, tool rows (`["t",ToolRun]`
→ `toolCard`), sets `PENDING`, `PLAN`, and maps `j.state` into `cur` — falling back to
`j.error?"error":"success"`.

**Busy/typing indicator.** `busy` renders a three-dot bubble `.tpk` at the thread tail
(`ui/index.html:126,358`) and `upd()` refreshes it in place (`ui/index.html:374`). No timeout,
no `AbortController`, no cancel; a hung router request leaves dots forever.

**Markdown.** `md()` (`ui/index.html:327-343`): `esc()` whole input first (`ui/index.html:326`),
fence/inline-code tokenized with NUL placeholders, then line-parser for headings/lists/paragraphs,
link regex restricted to `https?://` with `rel="noopener noreferrer"`. Applied only to chat
bubbles (assistant and user) at `ui/index.html:358`; tool cards use a cruder
`.replace(/</g,"&lt;")` (`ui/index.html:357,360-361`) which leaves `&` unescaped (display glitch,
not injection).

**Mascot.** `pose(k)` (`ui/index.html:352-354`) maps state key → `PS` pose (CSS custom props on
the inline SVG `MXSVG`, `ui/index.html:242-289`), toggles per-state props (`.pp.pr-*`), and
`upd()` (`ui/index.html:372-374`) recolors the theme (`--t` from `S[k].c`), sets the pill icon,
ring progress, and the header verb ticker `tick()` (`ui/index.html:389`, randomized verbs from
`S[k].v` on a 2.2s interval, `ui/index.html:395`). Idle micro-animations (wink/twitch/hip) fire
every 5.2s when idle (`ui/index.html:396`). `MK={files:"read"}` (`ui/index.html:348`) aliases the
state name to a pose.

**Approve flow.** On `POST /api/message` the agent holds risky commands (`isRisky` in
`src/guardrails.ts:15+`, `holdAction` `src/memory.ts:239`) and returns
`pending:{id,cmd}` (`src/types.ts:36-37`). UI stores it in `PENDING` (`ui/index.html:385`);
`card("approve")` renders a glowing ask card with the command in a `<code>` block and
Deny/Approve buttons wired to `decide(bool)` (`ui/index.html:309,388`) → `POST /api/approve`
(`src/index.ts:97-113`) → `approveAction()` runs/denies in sandbox and returns
`{ok,reply,state,output}` (`src/agent.ts:277-309`). `loadPlan()` (`ui/index.html:387`) also
rehydrates `PENDING` from the server on boot and flips `cur` to `approve` **only when `cur` is
`idle`** — so a held action can be silently invisible if the mascot is in any other state.

**Tasks tab.** Live vs done split (`ui/index.html:359`); live rows show status + due date and a
**fake** `<div class="pr"><i style="width:60%">` progress bar (`ui/index.html:360`); the last 4
done tasks become the "While you were away" timeline in both the Tasks tab (`ui/index.html:361`)
and the inspector `LG` (`ui/index.html:386`), keyed by `awayState()` regex-over-title heuristic
(`ui/index.html:350`). Cron run output is logged server-side (`logMessage`, `src/agent.ts:356`)
and never shown.

**Layout/responsive.** Single page: rail+persistent sidebar ≥900px (`ui/index.html:88`),
inspector column ≥1200px (`ui/index.html:90`), drawer + scrim on mobile (`ui/index.html:77-78`,
toggled `side()` `ui/index.html:379`), dock tab pills with `aria-selected` expansion
(`ui/index.html:75`). Recent fixes visible: `scrollEnd()` auto-scroll after render
(`ui/index.html:356,374`), sidebar `overflow-x:hidden` (`ui/index.html:77`), `.m pre` has
`overflow-x:auto` (`ui/index.html:56`).

**Auth/API surface.** All five UI-called endpoints require the same shared bearer
`AGENT_API_KEY` (`src/index.ts:59-113`). WS upgrade accepts `?token=` in the query string
(`src/index.ts:47`) — logged by any proxy/browser history if used. The UI never calls
`/api/decide`, `/health`, or `/internal/vault/*`.

## Problems & risks

- **[Critical] Chat transcript is browser-RAM-only.** `LOG` (`ui/index.html:344`) is lost on
  refresh; `pick()`/`newChat()` (`ui/index.html:380-381`) wipe it, and the "chat list" is a
  fiction since the server keeps one conversation (`src/agent.ts:218`). Meanwhile the DO already
  persists every message (`src/memory.ts:56-62,128-144`) — the data exists but no endpoint
  exposes it. Users lose context constantly and multi-session UX is broken.
- **[Critical] API key stored in `localStorage` in plaintext** (`ui/index.html:384-388`), sent
  as a Bearer header on every request and (if WS is ever adopted) accepted in a URL query
  (`src/index.ts:47`). Any XSS or browser-extension compromise exfiltrates the single shared
  secret that also gates shell exec. No way to view/clear it (no "logout"), capture via
  `prompt()` is undiscoverable, and the repo/console is public-facing.
- **[Critical] Approvals are not live.** `PENDING` is refreshed only on boot and after a user
  send (`ui/index.html:387,397`); a high-risk command held by a *background cron* run
  (`src/agent.ts:343-359`) produces no UI signal until the next interaction — the run silently
  waits. Also `loadPlan()` only enters `approve` state when `cur=="idle"`
  (`ui/index.html:387`), so the ask card can be skipped even when polled. The approve card
  itself renders only via `upd()` when `cur=="approve"` — honest copy (`ui/index.html:309`), but
  there's no notification, badge count, or audio.
- **[Major] Failure states misreported as success.** `fedChat` maps a reply with no `state` to
  `success` (`ui/index.html:385`), and `src/agent.ts:744` returns
  `{reply:"Router returned 530."}` with *no state and no error field* → mascot celebrates,
  confetti pose fires (`ui/index.html:227,277`), while the bubble says the router failed.
  Same for `agent error:` replies (`src/agent.ts:222`). "sandbox error" is at least shown in a
  red tool card (`ui/index.html:357`) but the mascot state still depends on the deterministic
  mapper.
- **[Major] No streaming, no cancel, no timeout.** One-shot `fetch` per turn
  (`ui/index.html:385`); router call itself is `stream:false` (`src/agent.ts:996`). Long turns
  show dots indefinitely with no `AbortController` and no Stop button; the user cannot tell
  whether work is progressing or dead.
- **[Major] Docs and Ideas are dead tabs** (`ui/index.html:365-366`). The stated product intent —
  "if an agent makes a doc/txt it shows up in Docs" — is unimplemented end-to-end: no tool asks
  the model to publish a document, no table, no endpoint, no renderer. `/internal/vault/*` is
  unrelated infra sync (`src/vault.ts:1-4`, `src/index.ts:195-198`). Same for Ideas (no writer,
  no reader).
- **[Major] Tools tab toggles are fake controls** (`ui/index.html:367-368`): checkboxes with no
  handler; they imply per-tool enable/disable exists. Dishonest UI for a safety-relevant surface.
- **[Minor] No empty/loading/error states on non-chat tabs.** `loadTasks`/`loadPlan` swallow all
  errors (`catch(e){}` `ui/index.html:386-387`); a 401 (wrong key) silently shows "No jobs yet"
  instead of "not connected", and Tasks can look empty when the real problem is auth.
- **[Minor] Away timeline shows titles only** (`ui/index.html:361`); cron job *results*
  (`[scheduled] …` in `src/agent.ts:356`) never reach the UI; recurring jobs' last-run output
  and failure rows (`src/agent.ts:357-359`) are invisible.
- **[Minor] `NF` animation-window logic is inconsistent** (`ui/index.html:344,378,384-385`):
  `render()` resets `NF=99` but `renderThread()` paths don't, so after an assistant reply every
  later `upd()` re-animates the last message; the `nw` entrance re-triggers on unrelated state
  changes.
- **[Minor] Escaping inconsistency:** `toolCard` and task titles hand-roll `.replace(/</g,"&lt;")`
  (`ui/index.html:357,360-361`) while everything else uses `esc()`; `&` renders wrong, and future
  attribute-context insertions from these helpers could bite.
- **[Minor] Accessibility gaps:** tabs have `role=tablist`/`aria-selected`
  (`ui/index.html:208,214,377`) but no arrow-key roving focus (tab buttons are only mouse/click);
  mascot `role=button` responds to Enter but not Space (`ui/index.html:210`); whole-screen
  `innerHTML` rebuild on every render (`ui/index.html:376-378`) destroys focus (typing in the
  composer works only because `#inp` sits outside `#scr`); search input re-renders sidebar on
  every keystroke (`ui/index.html:371`); reduced-motion is respected (`ui/index.html:92`) and
  `:focus-visible` outlines exist (`ui/index.html:28`) — good baseline.
- **[Minor] `md()` residuals:** single-`*` emphasis regex is fragile around apostrophes/`*` in
  code-adjacent text (`ui/index.html:330`); no tables/images/blockquotes/HR support; fenced code
  has no copy button; user messages are markdown-parsed too (surprise formatting on "2*3*4").
  The core XSS posture (escape-first, http(s)-only links, `rel=noopener`) is sound.
- **[Minor] Legacy/debug backend surface kept live:** `/api/decide` with a `__debug_url` probe
  branch (`src/index.ts:115-139`) returns router origin + key-length metadata to any holder of
  `AGENT_API_KEY`; unused by the UI, should be removed or gated.
- **[Minor] Dead affordances:** mic and attach buttons (`ui/index.html:213`) with no behavior;
  peek auto-timer (`ui/index.html:383`) can feel like UI glitches; "Blip app v7" title
  (`ui/index.html:1`) leaks internal versioning.

## Near-term improvements

1. **Persist + restore the transcript.** Add `GET /api/history?limit=` returning `recentMessages`
   (`src/memory.ts:144`) rows mapped to UI bubbles; load on boot before `render()`
   (`ui/index.html:397`). Also move the key prompt out of `send()` into a proper connect screen.
2. **Honest error states end-to-end.** Have `handleChat` failures return
   `{reply, state:"error", error:"router <status>"}` (fix `src/agent.ts:740,744`), and in
   `fedChat` treat "no state" as neutral `idle`, not `success` (`ui/index.html:385`). Add an
   inline retry chip on error bubbles. Surface 401 from `loadTasks/loadPlan` as a "Not
   connected — press to set key" banner instead of swallowing (`ui/index.html:386-387`).
3. **Approval visibility.** Poll `/api/plan` on an interval (or push via WS), force `cur="approve"`
   whenever `pending.status==="held"` regardless of current state, badge the dock Tasks tab, and
   fire a Notification when the tab is hidden. Keep the existing `card()` ask UI
   (`ui/index.html:309`) — it is already honest.
4. **Make Tools toggles real or remove them.** Either wire toggles to a server-side tool allowlist
   or replace the switch with a status pill (connected / planned / not configured).
5. **Docs/Ideas: stop shipping dead tabs short-term** — hide them or show a "coming soon" row that
   links to a tracking issue — then build the real stores (below).
6. **Small hygiene:** unify escaping on `esc()`; drop `NF` complexity or fix re-animation; add
   Space key to the mascot button and arrow-key nav to tablists; delete `/api/decide`
   `__debug_url` branch; add `AbortController` with a ~90s timeout and a Stop button that
   aborts the local fetch and shows "[stopped] reply may still complete server-side".

## Next features (prioritized, effort)

1. **Streaming UI** (M-L). Transport: use the *existing* WebSocket path (`src/index.ts:42-53`,
   `src/agent.ts:311-340`) with frames `{type:"chat"}` → server emits
   `{type:"delta",text}` chunks and a final `{type:"chat", ...AgentReply}`; router call switches
   `stream:true` for the final-answer leg (`src/agent.ts:996`). UI: append deltas into a live
   assistant bubble, re-run `md()` on each chunk against a stable buffer (throttled ~100ms),
   trailing `.cur` caret (style exists, `ui/index.html:108`), swap typing dots for the first
   delta, keep tool cards inline as they complete, and honor the Stop button via
   `ws.send({type:"cancel"})` (new frame type). Fallback: SSE on `/api/message` with
   `stream:true` if WS auth proves awkward; never put the key in the WS URL — the header path
   works for same-origin JS WS in browsers (`src/index.ts:44-46`), so drop `?token=` from the UI.
2. **Real Documents store for the Docs tab** (M). New SQLite table `documents(id,title,kind,body,
   created_at)` beside `plan_steps` (`src/memory.ts:201+`); new agent tools `save_document(title,
   body)` / `list_documents` / `get_document` (pattern-match `schedule_task` in
   `src/agent.ts:640,801`) *and* an auto-capture hook: when `exec`/`write` produces a text file in
   `/workspace` (or the reply contains a fenced doc the user clicks "Save to Docs"), store it.
   Expose `GET /api/docs` + `GET /api/docs?id=` (`src/index.ts` route block) and rewrite
   `SC.docs` (`ui/index.html:365`) to a card grid (styles `.docs/.dc` already exist,
   `ui/index.html:120`) with an md()-rendered reader pane and copy/download actions. This fulfills
   the user's stated intent that "any doc/txt an agent makes gets saved in Docs".
3. **Job history / result view** (S-M). Tasks tab row click → detail pane with `payload`,
   last-run status, and the `[scheduled]` result text (persist a `result` column on `tasks`, or
   read `logMessage` rows). Replace fake 60% bar (`ui/index.html:360`) with real states
   (pending/running/failed/retry-count). Back the "While you were away" timeline with actual run
   summaries, not titles.
4. **Tier/model switch in the composer** (S). `ChatRequest.tier` already accepts
   `primary|cheap` (`src/types.ts:43-46`); `fedChat` hardcodes `"primary"` (`ui/index.html:385`).
   Add a segmented control (Fast/Smart) in `.cmp` persisted per-thread; optionally expose
   `MODEL_PRIMARY`/`MODEL_CHEAP` names via a new `GET /api/models` so the UI shows real models.
5. **Stop/cancel mid-reply** (S, prerequisite for streaming honesty): `AbortController` on the
   fetch/WS + a Stop button swapping in beside Send while `busy` (`.cmp.has .snd` area,
   `ui/index.html:71`).
6. **Background-job notifications** (S-M). `document.visibilityState` + Notification API on
   `PENDING`/new done-tasks (needs the polling/WS from #3 above); badge the dock tab and the
   header run pill (`ui/index.html:211`).
7. **Message actions: copy / retry / edit-resend** (S-M). Per-bubble hover toolbar on `.m`
   entries (`ui/index.html:358`): copy raw text, retry (re-send previous user message), edit
   (refill composer). Requires stable message ids in `LOG` tuples.
8. **Real multi-thread chat** (L) — server-side `thread_id` on `chat()` and `messages`;
   sidebar list (`ui/index.html:346,369-371`) then stops being decorative. Defer until #1 exists.

## Open questions for the user

1. Docs semantics: should *every* text file the sandbox agent creates auto-mirror into Docs
   (needs `save_workspace`-style capture), or only what the model explicitly publishes via a
   `save_document` tool? Retention/quota for DO SQLite (2MB row cap, `src/vault.ts:3-4`)?
2. Ideas: is "Things Blip noticed" meant to be model-generated suggestions (proactive), user
   quick-capture, or distilled from `memories`? Who writes them and when?
3. Streaming transport preference: adopt the already-auth-gated WebSocket for chat (also enables
   push approvals), or keep HTTP and add SSE? Is the `?token=` query auth (`src/index.ts:47`)
   allowed to be dropped?
4. Single shared `AGENT_API_KEY` for a personal agent is accepted risk? Any appetite for a
   per-device/session token so the browser key can be revoked (also fixes the localStorage
   exposure, `ui/index.html:384`)?
5. Should the fake multi-chat sidebar be removed until threads are real, or kept as UI scaffolding?
6. Tools tab toggles: do you want real per-tool kill switches (server-side allowlist), or is a
   read-only capability status page enough?
7. Approvals: acceptable to hold the UI in an unmissable `approve` mode (blocking other states)
   until every held action is decided, including ones raised while the tab is closed (requires
   push/poll)?
8. What should the away timeline show for recurring jobs — last result summary, or full run log?
