# Blip design spec (v0)

Handoff for rebuilding and polishing the Blip app UI. Reference build: `blip-app.html`. Everything below matches that file. Keep the structure, upgrade the motion.

## 1. Product idea
Autonomous agent app. The agent works in the background using tools (browser, files, terminal, email, wallet). The UI must always show **what it is doing right now**. Mascot = the agent's body language.

## 2. Tokens

### Color (neutral)
| Token | Light | Dark |
|---|---|---|
| bg | #F6F3FB | #150F1F |
| surface | #FFFFFF | #221A31 |
| ink | #1B1426 | #F3EEFA |
| mute | #6E6580 | #A79DBB |
| line | #E4DEF0 | #352B49 |

### Color (tool accents, same in both themes)
| Tool | Hex | Glyph |
|---|---|---|
| Butter (brand, plan, idle) | #FFD66B | ✦ |
| Web / Browser | #62B4FF | ◎ |
| Files / Documents | #5FD8A6 | ▤ |
| Code / Terminal | #FF7EB6 | >_ |
| Mail | #B59CFF | ✉ |
| Wallet / Needs OK | #FF7A6B | ◈ and ! |

Rules: accent is used only as a fill or tint (icon square, status dot, progress bar, card header at 16% mix). Never as small text color. Text on accent fills is always #1B1426. User bubble: #BFD9FF with ink text.

### Type
- Voice and UI: `ui-rounded, "SF Pro Rounded", Nunito, system-ui` (swap for a real rounded face).
- Tools and status: `ui-monospace, "SF Mono", Menlo`.
- Scale: screen title 28/700 (-0.02em), body 16/1.45, secondary 14, status pill 13 mono, tab label 11.

### Shape, space, elevation
- Radius: phone 38, card 22, row 18, button 14, chip/pill 999, icon square 12.
- Spacing: 4pt grid. Screen padding 18. Gap between blocks 12.
- Elevation: flat (1px line border), floating (tab bar: `0 10px 24px -12px rgba(27,20,38,.5)`), phone shadow only on desktop.

### Motion tokens
- fast 150ms, base 250ms, slow 400ms.
- spring: `cubic-bezier(.3,1.5,.5,1)` for pop-ins, toggles, tab selection.
- v0 uses stepped (pixel) motion for the mascot only. UI motion should be **smooth**.

## 3. Mascot
- 12x12 pixel grid, viewBox `0 0 19 12`, `shape-rendering: crispEdges`.
- Body palette: body #FFD66B, shade #E3A93A, cheeks #FF9DB0, eyes #1B1426.
- Layers: `body` > `look` > `eyes`, plus `prop` (6x6 sprite at x=13,y=5, tinted by tool accent).
- Props: plan = thought dots, browser = magnifier, files = page, terminal = prompt box, mail = envelope, wallet = card, approval = check.

### States and motion
| State | Eyes | Body | Prop |
|---|---|---|---|
| idle | blink every 4s | slow bob | none |
| plan | look up-right | side wobble | thought dots rise |
| browser | scan left and right | bob | magnifier bobs |
| files | look down at prop | slow nod | page bobs, highlight line fills |
| terminal | focused | fast typing tap | prompt jitters |
| mail | normal | hop | envelope slides in |
| wallet | squint (careful) | slow lean | card held steady |
| approval | wide open | hopeful hop | check held out |

Transitions between states: 200 to 400ms, anticipation then settle, prop pops in from the hand. Eyes always move first.

**Upgrade brief:** rebuild as a Rive state machine (one rig, one input "state", props as swappable nested artboards). Smooth squash and stretch, spring overshoot, subtle secondary motion on ear nubs. Add one-shots: success sparkle, error sheepish shrug, wake-up. Reduce Motion: static pose per state.

## 4. Components
1. **Status pill:** accent dot (pulsing) + rotating verb (changes every 2.2s) + elapsed `m:ss` in mono. Verbs are playful and tool-specific (Compiling, Poking the shell, Counting carefully).
2. **Progress bar:** 4px, accent fill, under the header.
3. **Tool card:** header (16% accent tint, 38px icon square, tool name, step text) then live preview then full-width action button. Pops in with the spring. Previews: plan checklist, mini browser grid scanning, document lines with moving highlight, terminal with blinking cursor, mail fields, payment summary.
4. **Approval card:** the only pulsing element. Title is the exact action, one line of detail, Edit and Approve buttons. Approve has the accent fill and a ring pulse. After approval the mascot returns to idle and says what happens next.
5. **Chat bubbles:** user on the right (#BFD9FF), agent on the left (bg tint).
6. **Tab bar:** floating pill, 5 tabs with glyph and label, selected tab is ink-filled and lifts 2px with the spring.
7. **Row:** 18px radius, accent dot, title, secondary line, trailing glyph or switch.
8. **Toggle:** 48x28, accent when on, knob springs. Wallet is locked on and says it asks every time.

## 5. Screens
- **Chat:** mascot header, status pill, progress bar, "done while you were away" row, messages, live tool card, input.
- **Tasks:** running list with tool dots, then a vertical timeline of what happened while the user was away.
- **Docs:** 2-column grid of things the agent made, thumbnail tinted by tool.
- **Ideas:** proactive suggestions, each with Not now and Do it.
- **Tools:** permissions list with toggles and plain-language descriptions.

## 6. Principles
1. Show the work: every action has a card, a prop, a verb.
2. One color per tool, used everywhere that tool appears.
3. High-stakes moments (send, pay) look different from chat.
4. Motion answers action or shows progress. No decorative loops except the mascot.
5. Sentence case, active verbs, errors say what happened and how to fix it.

## 7. Accessibility
Contrast on accent fills uses ink text. Visible focus ring (2px ink, 2px offset). `prefers-reduced-motion` disables all animation. Tab labels always visible. Touch targets at least 44px.

## 8. Next for the polish agent
- Swap system fonts for a real rounded family and a mono.
- Make the mascot smooth and expressive (see section 3).
- Add haptics: light on tool start, medium on approval request, success on done.
- Add the voice mode and the second-level screens (single task detail, doc viewer).

## 9. v1 changes (supersedes where different)
- Dark-first. Dark surfaces: s1 #171024, s2 #1F1731, s3 #2B2142, line rgba(255,255,255,.09). Light: s1 #FFF, s2 #F6F2FC, s3 #E9E2F5.
- `--t` (current tool color) is a registered `@property` so every accent, glow and border cross-fades over 700ms when the tool changes.
- Chat hero is a **stage**: mascot at 190px, a radial glow in `--t`, rising pixel particles in `--t`, a 28/800 verb headline, a tool tag, and a 4-segment step bar (done, current filling, upcoming).
- Tool cards have a live badge, a tinted border, and a glow shadow in `--t`. Approval card has a pulsing ring.
- Icons are a custom 24px stroke set (1.8 width, round caps and joins).
- User bubble is ink-filled (inverts per theme). Floating blur dock and composer.

## 10. Mascot v1 (vector rig, supersedes section 3)
Reference build: `blip-mascot.html`. The pixel version is retired. Blip is now a layered vector character.

### Anatomy (viewBox `-20 0 280 240`, character centered at x=120)
- **Body:** squishy dumpling, radial gradient `#FFF3C4` to `#FFD66B` (45%) to `#EBA93A`. Belly patch `#FFF6D6` at 55%, bottom shade `#C88415` at 22%, gloss stroke (white, 45%) top-left.
- **Ears:** two rounded nubs with pink inner `#FF9DB0`, pivot at the base, wobble out of sync.
- **Antenna orb:** the status light. Fill is the current tool color (`--t`), with a pulsing halo. It is the one element that always shows what tool is active.
- **Eyes:** glossy dark ovals (`#3A2C57` to `#1B1426`), one big and one small white highlight each. Variants: normal, wide (x1.15), squint (y x0.55), happy arcs, closed arcs. Blink every 4.6s (scaleY to 0.08 at 95%).
- **Brows:** hidden at rest, fade in by state. Worried = inner ends up, determined = inner ends down.
- **Mouth:** smile, smirk, flat, sad, small o, open grin.
- **Cheeks:** `#FF8FA8` at 55%. **Arms:** capsule `#E3A33A` plus round hand, pivot at shoulder (66,150) and (174,150), length 40. **Feet:** `#E3A93A`.

### Pose system (this is what makes it smooth)
Register these with `@property` and transition them on the root `svg`: `--la --ra --w` (angle), `--ex --ey --by` (length), `--ba` (angle), `--bo` (number), `--t` (color). Springs: arms `cubic-bezier(.34,1.4,.64,1)` 0.9s, eyes 0.6s, brows 0.5s, color 0.8s. Because keyframes read these variables, poses blend smoothly even while a loop is running.

Per state: `[leftArm, rightArm, wiggle, wiggleDuration, eyeX, eyeY, browY, browAngle, browOpacity]`
| State | Pose | Body loop | Extras |
|---|---|---|---|
| idle | 10, -10, 4, 4s, 0, 0, 0, 0, 0 | breathe 4s | eyes drift 9s |
| plan | 14, 58, 3, 2.4s, 7, -7, -1, 10, 1 | sway 3.6s | thought cloud, 3 bouncing dots |
| browser | 12, -115, 6, 1.6s | bob 1.8s | window, wandering cursor, eyes scan 2.2s |
| search | 22, -100, 5, 1.8s, 4, 0, -6, 0, 1 | lean 2.6s | magnifier sweeps an arc, wide eyes, "o" mouth |
| files | 100, 14, 3, 2.6s | nod 3.2s | page floats left, highlight walks lines, eyes read |
| terminal | -40, 40, 13, 0.36s, 0, 3 | buzz 0.36s | keyboard, alternating taps (half-period offset), self-typing terminal |
| email | 10, -100, 5, 1.4s | hop 1.8s | envelope appears, flies up-right and fades, shadow shrinks |
| wallet | -52, 52, 1.5, 3s, 0, 4, 1, 14, 1 | careful 3.4s | card in both hands, squint, lock bobs |
| approval | -52, 52, 3, 1s, 0, 3, -6, -12, 1 | hope 1.6s | "?" box held out, pulsing ring, wide eyes |
| done | 155, -155, 10, 0.5s | cheer 1.9s | confetti burst, check badge pops (one-shot) |
| error | -25, 25, 2, 0.25s, -3, 3, 0, -16, 1 | droop 2.4s | ears droop, sweat drop, wobbling "!" badge |
| background | 6, -6, 2, 5s, 0, 0, 2, 0, 0 | snore 4.8s | eyes closed, ears down, floating Zs |

### Motion rules
- Squash and stretch on every jump: anticipation squash (1.07, 0.93), stretch up (0.94, 1.07), landing squash, settle. Shadow shrinks to 0.62 at the peak.
- Everything is `ease-in-out`. Pose changes and prop pop-ins use the spring. No stepped motion.
- Props enter with `translateY(12px) scale(.6)` to identity over 0.7s spring. Hand-held props live inside the body group so they squash with it. Floating props float on a 3.2s sine.
- Eyes lead, the face shifts 45% of eye travel, then the body follows.
- Reduce Motion: keep the pose and prop, disable all loops.

### Polish agent: what to upgrade
Rebuild in Rive with the same rig names and the same state table as inputs. Add: anticipation frames before each state change, a wake-up stretch (background to idle), a one-shot "wave" when the app opens, finger-level hand poses, and eyelid-based blinks with a double-blink every few cycles. Add haptics on approval, done, and error.

## 11. Mascot inside the app (v2)
- The chat stage hosts the vector rig from section 10 at about 268px wide, viewBox `-20 10 280 220`, centered over the tool-color glow. The old pixel mascot and rising particles are gone.
- **One persistent SVG element.** It is moved between screens, never re-created on a state change, so every registered CSS variable (`--la --ra --ex --ey --by --ba --bo --t`) transitions smoothly between poses. Only the text, tag, step bar, message and tool card around it update.
- **State map:** app state to mascot state is 1 to 1 except `files` to `read`. App states are now: idle, plan, browser, search, files, terminal, email, wallet, approval, done, error, background.
- **Flow:** pressing Approve plays the `done` state for about 4s (jump, confetti, check badge), then returns to idle.
- **Stage text:** headline is 24/800 on one line (ellipsis if long), animated dots only while a task is running, tool tag and step text under it, 4-segment step bar below.
- Class names were prefixed to avoid collisions when combining files: props `pp`, mouth `mt`, terminal lines `tx`, cursor `cr`. Keep these if you port the rig.

## 12. Chat UX (v3, supersedes the stage layout in section 11)
Rule: **the conversation is the product, the mascot is the status light.** The mascot never takes more than about 15% of the screen.
- **Sticky agent bar** under the top bar: mascot at 112px wide, 20/800 one-line headline (ellipsis if long, dots only while working), tool tag, step text, elapsed time, and the 4-segment step bar. Bottom hairline. It never scrolls away.
- **Thread** fills the rest: user bubble, agent bubble, live tool card. It auto-scrolls to the newest item on every state change.
- **Top bar:** left = chats menu, center = thread title, right = "3 running" pill (accent dot, opens Tasks). The old "+" invite button is gone.
- **Chats drawer** (hamburger): slides from the left over a scrim, 84% wide, springy. Search field, list of threads with a tool-color dot, live status line, and a "Needs you" badge for threads waiting on approval. Selecting a thread switches the title, the user message, and the agent state.
- **Bottom:** composer (52px) above a 52px dock. Thread bottom padding 138px so nothing hides behind them.
- **Tool cards are compact:** seat grid cells at 1.7 aspect, 12px paddings, actions in one row. A card plus both bubbles fit on a 800px phone without scrolling.
- Optional later: tap the agent bar to peek the large mascot, quick-reply chips above the composer, swipe a thread in the drawer to archive.

## 13. Mascot v2: full tool vocabulary (23 states)
Reference: `blip-mascot.html` (rig) and `blip-app.html` (in context). Poses use the same tuple as section 10: `[leftArm, rightArm, wiggle, wiggleSeconds, eyeX, eyeY, browY, browAngle, browOpacity]`.

| Group | State | Color | Motion and prop |
|---|---|---|---|
| Basics | idle | #FFD66B | breathe, blink, drift. Random one-shots every ~5s: wink, ear flick, small hop |
| | wave | #FFD66B | big waving arm, happy eyes, "Hi!" bubble, double bounce |
| | plan | #FFD66B | hand on chin, thought cloud |
| | listen | #67E8F9 | hand cupped to ear, ears perk, live voice meter |
| | wait | #CBD5E1 | arms crossed, flipping hourglass, slow sway |
| | background | #8E86B8 | eyes shut, ears down, Zs |
| Web | browser | #62B4FF | window, cursor, eyes scan |
| | search | #4FD1E8 | magnifier sweep, wide eyes |
| Files and code | files (read) | #5FD8A6 | page floats, highlight walks lines |
| | write | #FFA94D | notepad, pen hand scribbles, lines appear |
| | terminal | #FF7EB6 | keyboard taps, terminal types itself |
| | analysis | #2DD4BF | glasses on, bar chart grows bar by bar |
| Messages and time | email | #B59CFF | envelope hop and fly-away |
| | messages | #7C9CFF | chat bubbles pop in and out, typing dots |
| | calendar | #A3E635 | header flips like a page, today pulses |
| Money | wallet | #FF7A6B | card in both hands, squint, lock |
| | shopping | #E879F9 | cart, items drop in one by one |
| | approval | #FF7A6B | "?" box held out, pulsing ring |
| Create and remember | creating | #FF8FA3 | brush, canvas strokes draw themselves, sparkles |
| | memory | #FFD66B | glowing note flies into the belly, belly glows |
| | sub-agents | #A78BFA | arms up, three mini Blips with their own tool lights bounce around |
| Outcomes | done | #5FD8A6 | jump, confetti from the head, check badge |
| | error | #FF6B81 | droop, sweat drop, wobbling badge |

### Smoothness rules (v2)
- All loops use ease-in-out sine `cubic-bezier(.37,0,.63,1)` (`--sine`). Jumps use per-segment easing: ease-out going up `(.2,.8,.3,1)`, ease-in coming down `(.7,0,.9,.4)`, overshoot on landing `(.3,1.4,.6,1)`.
- **State-change pulse:** a wrapper group (`.sq2`) plays a 0.6s squash-and-settle on every state switch, which hides the loop restart so transitions never pop.
- Every pose number is a registered custom property, so arms, eyes, brows and the tool color all spring between states. Keep it that way in Rive (state machine inputs, not discrete clips).
- Idle is never still: wink, ear flick, and a small hop are triggered at random.

### More tools an agent can use (not yet animated)
Database lookup (cylinder, rows stream in), upload/download (cloud with progress), phone call (handset, ring waves), maps and travel (pin drops, route draws), screenshots and computer use (camera flash), security check (shield, lock click), long-running job (progress ring around the antenna), retry loop (wipes brow, tries again), learning from docs (book, light bulb pops).

## 14. Mascot v3: eye system and fine detail
Reference: `blip-mascot.html`. The eyes are now a real layered eye, not a dark oval. Build them as layers, top to bottom:
1. **Glints:** one big white highlight (upper right, r 4.2) and one small (lower left, r 2). They stay fixed on the eye while the iris moves under them, like a real glossy eye.
2. **Pupil:** `#0F0A18`, rx 4.4 ry 5.8. Dilates: wide x1.22, squint x0.82, error x0.68 with a fast tremble.
3. **Iris:** filled with the **current tool color** (`--t`), rx 8.8 ry 11.2, plus a dark limbus ring (radial, transparent at 50%, `#0F0A18` at 80% opacity) and a soft light crescent at the bottom (white 22%). So the eyes themselves tell you which tool is active.
4. **Socket:** `#1B1426`, rx 11.5 ry 14.5. Iris and pupil are clipped to it.
5. **Eyelids:** not painted shapes. The eye group is clipped by an animated rectangle, so the lid edge moves with no color matching needed. Open = edge above the eye. Closed = edge 40px lower. Resting lid height per state: squint 10px, bored (waiting) 13px, focused (terminal, wallet, writing, planning) 8px. The lid also tilts with the brows (angle x 0.9, mirrored on the right eye): inner end down = determined, inner end up = worried.
6. **Lash line** fades in only at the blink peak.

### Gaze
- Pupil offset = `state gaze x 0.38 + animated gaze + pointer`, clamped to 4.8px x and 5px y, so the iris never leaves the socket.
- Eyes lead the head: pupils move at 0.6s, the face (head turn) follows at 0.9s with an 80ms delay, then the body.
- **Reading** is a real line-by-line saccade: sweep right, snap back left one line lower, repeat three lines.
- **Browser** scans left and right, **idle** drifts with tiny saccades, **error** pupils shrink and shiver.
- **Pointer tracking:** pupils follow the cursor or finger (max 2.6px x, 2.2px y), eased over 250ms. On the rig sheet every tile follows at once.

### Blink
6s cycle: one slow blink at 40%, a double blink at 88% and 92%. Right eye lags 20ms. Never synchronized across tiles.

### Other details added
- Antenna sways on its own with a 3.4s lag, and the orb sends out a ping ring on every state change.
- Cheeks blush brighter when happy (wave, done, memory) and fade when scared (error).
- Open grin has a tongue and a talking motion while waving. The listening mouth pulses like a small "o".
- Hands have a highlight. Waiting taps one foot.
- Register all new variables as typed properties so they interpolate: `--gx --gy --px --py --hx --hy --lid`.
