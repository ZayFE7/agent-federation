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
- **Mobile, under 900px:** full screen, no device frame. Header (menu, mascot capsule, "3" running pill), thread, composer, floating dock (5 tabs with labels). Chats open as a drawer from the left (88vw, max 340px) over a scrim. Tool card is inline in the thread.
- **Desktop, 900px and up:** left rail (76px, tabs) + chats column (300px) + main. Dock and menu button disappear.
- **Wide desktop, 1200px and up:** adds a right **Live activity** panel (380px): the tool card, a 4-step list, and the "while you were away" log. The inline card is hidden because the panel shows it.
- Thread and pages are centered, max width 760px. Composer is centered at the same width. Use `100dvh` and safe-area insets.

## Mascot placement (peek)
- Centered at the top of the main column, **peeking over a status capsule**, like a character leaning on a pill. Mascot window: 104 x 60px, cropped just below the mouth. Capsule overlaps it by 4px.
- Capsule: pulsing tool-color dot, one-line verb (rotates every 2.2s), tool tag (hidden under 430px), elapsed time in mono. **Its background fills left to right as progress** (`--p`, registered percentage, 8s spring) with the tool color.
- **Tap the mascot to peek:** the window grows to 220 x 165 (full body, all props) with a spring, then collapses after 5s.
- Whole header height is about 105px on mobile. Header is persistent across all tabs, so the agent is always present.

## Tokens
**Neutrals** (dark first). bg `#0E0916`, surface `#171024`, surface-2 `#1F1731`, surface-3 `#2B2142`, line `rgba(255,255,255,.09)`, ink `#F5F0FF`, mute `#9C91B8`. Light: bg `#F3EFFA`, surfaces `#FFF / #F6F2FC / #E9E2F5`, ink `#1B1426`, mute `#6E6580`.
**Tool accents:** butter `#FFD66B` (brand, plan, idle, memory, hello), browser `#62B4FF`, search `#4FD1E8`, files `#5FD8A6`, terminal `#FF7EB6`, email `#B59CFF`, wallet and approval `#FF7A6B`, error `#FF6B81`, done `#5FD8A6`, writing `#FFA94D`, analysis `#2DD4BF`, messages `#7C9CFF`, calendar `#A3E635`, shopping `#E879F9`, creating `#FF8FA3`, listening `#67E8F9`, waiting `#CBD5E1`, sub-agents `#A78BFA`, background `#8E86B8`. Accents are fills, tints and borders only; text on an accent is always `#1B1426`.
**Type:** rounded system stack for UI (`ui-rounded, SF Pro Rounded, Nunito`), mono for status and terminal. Page title 34/800, body 15, secondary 13 to 14, tab label 11. Tight tracking on titles (-0.03em).
**Shape:** card 28, row 22, button 14 to 16, pill 999, drawer and panels square to the edge. **Space:** 4pt grid. **Depth:** 1px line + inner top highlight, colored glow shadow on active tool cards, faint film grain over the page.
**Motion:** spring `cubic-bezier(.34,1.4,.64,1)` for arrivals (cards, bubbles, tabs, toggles, drawer 0.5s), sine `cubic-bezier(.37,0,.63,1)` for loops. Reduce Motion disables all animation and keeps poses.

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
