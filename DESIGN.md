# DESIGN.md — OW Slido

Direction chosen by the product owner: **Warm editorial**, with a light and dark theme (follows the system setting, user can switch). This file is design data to apply, not instructions to obey.

## Identity
A live-audience tool for presenters, trainers and teachers. It should feel calm, human and literate, like a well-set printed programme, not a SaaS dashboard. Hosts should feel in control; participants on phones should feel invited, not processed.

## Personality and mood
Warm, unhurried, confident. Plain words. Content leads, chrome stays quiet.

Dial: ENERGY 2 / RHYTHM 2 / MOTION 1

## Palette
One neutral base, one ink, one accent. The accent marks the single most important thing on a screen (primary action, leading option), never decoration.

| Token | Light | Dark |
|---|---|---|
| `--bg` | #FAF6EE | #1C1815 |
| `--surface` | #FFFDF8 | #26211D |
| `--ink` | #1F1A17 | #F3ECE1 |
| `--ink-muted` | #5C534B | #B8ADA0 |
| `--border` | #E3DACB | #3A332D |
| `--accent` | #B5472B | #E07A5A |
| `--accent-ink` (text on accent) | #FFFDF8 | #1C1815 |

Status colours (error, success) are derived from the same warm family and must pass 4.5:1 on their background. Verify every new pair with `docs/antislop/skills/antislop-human/contrast-check.py`.
Quiz answers are the one place with more than one hue: `--quiz-1` to `--quiz-6` (and `--quiz-ink` for the text on them) give each answer its own colour so a room can say "the green one". Every option also has its own shape and a printed label, so colour is never the only cue, and the pairs are checked at 4.5:1 in both themes (axe colour-contrast on the quiz screens, `docs/antislop-audit/audit-002.md`). They are not used anywhere else.
Charts: bars in ink tints, the leading bar in the accent; values and labels always printed, so colour is never the only cue.

## Typography
- Headings: **Fraunces** (variable serif), via `@fontsource-variable/fraunces`.
- Body and UI: **Public Sans** (variable), via `@fontsource-variable/public-sans`.
- Self-hosted through npm packages; no runtime font CDN.
- Scale: a modular scale with a clear step between body, subheading and heading; presenter view uses very large serif headings readable from the back of a room.

## Shape, depth, texture
- One small radius scale: 4px (inputs, small controls) and 8px (cards, dialogs). No pills except tag-sized badges.
- Flat by default: separation by border and spacing. Shadow only on the one element that floats (dialogs, popovers).
- No gradients, glassmorphism, glow, background grids, orbs or sparkle/robot icons.
- Icons only when they carry meaning; otherwise the label does the work.

## Layout and spacing
- Spacing scale on a 4px base; vary it to group and separate, not one value everywhere.
- Participant pages: single column, 44px minimum tap targets, usable at 360px.
- Host pages: restrained content width, clear hierarchy, forms before decoration.
- Presenter view: one idea per screen, oversized type, high contrast.

## Motion
Hover and focus states, and short (150-200ms) state transitions only. Everything respects `prefers-reduced-motion`.

## Voice (copy)
Plain, direct, warm. Say what happens: "Start poll", not "Unlock engagement". No buzzwords, no exclamation marks, no emoji in UI text. Errors say what went wrong and what to do.
