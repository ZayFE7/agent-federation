# Blip: design brief

Blip is an autonomous agent app. The agent works in the background with tools (browser, files, terminal, email, wallet and more). The interface exists to answer one question at all times: **what is it doing right now, and does it need me?** The mascot is the agent's body language and status light.

## Files
| File | What it is |
|---|---|
| `blip-app.html` | The full responsive app prototype (mobile, tablet, desktop). Start here. |
| `blip-mascot.html` | The mascot rig: one character, 23 animated states, eye system. |
| `blip-rig-sheet.html` | All 23 states side by side, same canvas, all looping. Use as the animation reference. |
| `blip-design-spec.md` | Deep rig detail: pose tuples, eye layers, easing, per-state motion (sections 10 to 14). |

## Principles
1. **The conversation is the product, the mascot is the status light.** It never takes more than a thin strip at the top.
2. **Show the work.** Every tool call has a card, a color, a verb and a mascot pose.
3. **One color per tool, everywhere.** The same accent drives the mascot's iris and antenna, the capsule, the card, the dot in lists.
4. **High-stakes moments look different.** Sending and paying use the approval card (the only pulsing element).
5. **Motion explains.** Springs for things that arrive, sine easing for loops, nothing decorative.

## Layout and responsive rules (one DOM, three layouts)
- **Mobile, under 900px:** full screen, no device frame. Header (menu, mascot capsule, "3" running pill), thread, composer, floating dock (5 icons; the selected tab expands into a butter pill with its label). Chats open as a drawer from the left (88vw, max 340px) over a scrim. Tool card is inline in the thread.
- **Desktop, 900px and up:** left rail (76px, tabs) + chats column (300px) + main. Dock and menu button disappear.
- **Wide desktop, 1200px and up:** adds a right **Live activity** panel (380px): the tool card, a 4-step list, and the "while you were away" log. The inline card is hidden because the panel shows it.
- Thread and pages are centered, max width 760px. Composer is centered at the same width. Use `100dvh` and safe-area insets.

## Mascot placement (profile picture, name, status)
Centered at the top of the main column, three stacked pieces:
1. **Avatar (56px).** A circle with a soft tool-tinted fill and a white ring. Blip's ears and antenna light **break out of the circle** (clip = everything above the center line, plus the circle below), so it reads as a character, not an icon. A **progress ring** wraps it (conic fill in the tool color, animated with a spring as steps complete).
2. **Name** "Blip", 17px, weight 800.
3. **Status pill:** white, tinted shadow, a tool-colored icon tile (pulses), the verb with an ellipsis (re-types with a small rise every 2.2s), elapsed time.

Tap the avatar to **meet Blip**: it scales 2.7x with a spring, drops the circle clip so the full body and props show, the page blurs behind it, and it returns after 5s. The header is about 130px on mobile and persists on every tab. Menu button on the left (mobile only), "3 running" chip on the right.

## Tokens
**Palette (light, default).** Mist `#F2F0F9` base, Paper `#FFFFFF` surfaces, Fog `#F8F7FC` and `#E9E6F4` for insets, Plum `#241B3A` ink, Butter `#FFD66B` brand and user bubble, mute `#756C8C`, line `rgba(36,27,58,.09)`. **Dark:** `#120D1D`, `#1B1429`, `#231A36`, `#33274C`, ink `#F5F0FF`, mute `#A196BD`. Shadows are tinted violet, not grey, and tool cards add a glow in their own accent.
**Tool accents** (fills, tints, rings, borders; text on an accent is always plum): butter `#FFD66B` plan/idle/memory/hello, browser `#62B4FF`, search `#4FD1E8`, files `#5FD8A6`, terminal `#FF7EB6`, email `#B59CFF`, wallet and approval `#FF7A6B`, error `#FF6B81`, done `#5FD8A6`, writing `#FFA94D`, analysis `#2DD4BF`, messages `#7C9CFF`, calendar `#A3E635`, shopping `#E879F9`, creating `#FF8FA3`, listening `#67E8F9`, waiting `#CBD5E1`, sub-agents `#A78BFA`, background `#8E86B8`. For accent-colored **text** use `--td` (accent mixed 50% toward plum in light, 72% toward white in dark).
**Type:** one family, **Bricolage Grotesque** (variable, optical sizing on): 800 for the name and page titles, 600 for the pill and buttons, 500 for body. Tabular numerals everywhere. System mono only inside terminal previews. No all-caps labels.
**Shape (varied on purpose):** avatar circle, message bubbles 20 with one 6px tail corner, tool card 30 with a tinted header, rows 22, controls and pills 999.
**Motion:** springs `cubic-bezier(.34,1.3,.64,1)` only for things that answer an action (send, tab change, drawer, peek, card arrival); sine loops for the mascot. Only *new* messages animate. No hover effects on cards. Reduce Motion removes all of it.

## Components
Capsule, tool card (header + live badge, preview, Pause and primary action), approval card, message bubbles (user: ink gradient, right; agent: glass, left), composer (attach, input, mic that swaps to a tool-color send button when there is text), dock and rail tabs (selected = ink fill, lifts 2px), chat row (dot, title, live status, "Needs you" badge), chip, toggle, timeline, step list, doc card.

## Screens
**Chat** (thread + live card + composer). **Tasks** (running list with progress, timeline). **Docs** (responsive grid of things Blip made). **Ideas** (proactive suggestions, Not now / Do it). **Tools** (permissions with plain-language descriptions; Wallet is locked on and "asks every time").

## Interactions
- Send a message: Blip goes to the *thinking* pose, then routes by intent (mail, search, browse, code, pay, shop, calendar, memory, data, create, message, files, hello).
- Approve: mascot plays *done* (jump, confetti, check) for 4s, then idle. Pick a chat: title, message and state switch.
- Demo controls live in the chats list: every state as a chip, and an auto-cycle toggle. Any first interaction stops auto-cycle.
- Idle never stills: random wink, ear flick or hop every ~5s. Eyes follow the cursor or finger.

## Accessibility and performance
Visible focus ring in the tool color, all controls are real buttons, status is plain text in the capsule (the mascot is decoration), tab roles and `aria-selected`, 42px minimum touch targets. One persistent SVG for the mascot, props that are not in use are removed from the rig sheet, so many instances stay cheap.

## What the next pass should do
1. **Butter-smooth mascot:** rebuild in Rive with the same state names and pose numbers; add anticipation frames, a wake-up stretch, a one-shot wave on open, finger poses.
2. Swap system fonts for a licensed rounded face and a mono.
3. Real previews for each tool card (the current ones are lightweight stand-ins).
4. Second-level screens: single task detail, document viewer, voice mode, settings.
5. Haptics: light on tool start, medium on approval request, success on done.
6. Test lid animation (animated clip) and the registered-property transitions in Safari and Firefox.
