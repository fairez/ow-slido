# antislop audit 001 (mode: after)

Date: 2026-10-16. Scope: every page and component in `app/`, `components/`, `lib/` copy, `app/globals.css`, plus code comments in files changed on this branch. Direction: `DESIGN.md` (Warm editorial, ENERGY 2 / RHYTHM 2 / MOTION 1). Method: rule-by-rule grep and read of the source, then real-browser screenshots at 360 and 1280px in both themes. Priority follows rule tier: Hard Gate = HIGH, Purpose-Gate = MEDIUM, Quality Locks = LOW. The owner pre-approved fixing every HIGH and MEDIUM finding.

| # | Priority | Rule | Finding |
|---|----------|------|---------|
| 1 | HIGH | R-34, R-35 | AI analysis panels (`notes-analysis-panel`, `analysis-editor`, `published-analysis`) were never restyled: native unstyled buttons, inline styles and hardcoded colour fallbacks. They only render when AI is configured, so earlier browser checks never showed them. |
| 2 | MEDIUM | R-31, R-29 | Same files hardcode hex fallbacks (`#5c534b`, `#9b1c1c`, `#e3dacb`, `#8a8178`) instead of tokens; `#9b1c1c` is not the `--error` value. |
| 3 | MEDIUM | R-09 | "Outdated" marker in the analysis panel is a hand-rolled bordered span, not the `ui-badge` component. |
| 4 | MEDIUM | Part 1 "Colored Left Stripe" | `.moderation .post[data-state="pending"]` used a 4px accent left border. The section heading already says "Pending", so the stripe was decoration. |
| 5 | LOW | R-12 | `.ui-dialog` shadow uses a literal `rgb(0 0 0 / 0.25)`. Only floating element, so the shadow is allowed; the colour is not a token. |
| 6 | LOW | R-06 | `letter-spacing` on `.code-input` and `.join-code`. Kept: it separates digits of a six-digit code, not a style choice. |
| 7 | LOW | antislop-code | `tests/questions.test.ts` had a `// ---- Moderation (US-026) ----` banner comment. Story id references in comments carry no information. |

## Checked, no finding
- R-02/R-16: no em dashes, exclamation marks, emoji or buzzwords in UI text. No generic CTAs.
- R-01/R-10/R-12/R-13/R-07: no gradients, blur, glow or background grids.
- R-04/R-08/R-22: no icon library, arrows or illustrations.
- R-17/R-18/R-36/R-38: no statistics, testimonials or compliance claims.
- R-03: no horizontal overflow at 360 and 1280px (see `docs/mobile-audit.md`, screenshots re-run).
- R-25/R-32: see `docs/design-contrast.md`; axe run in US-031.
- R-19: motion limited to 150-200ms transitions plus a spinner, reduced-motion respected.
- Comments: remaining added comments state constraints or reasons; no separators, step narration or signature echoes.
