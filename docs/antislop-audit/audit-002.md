# antislop audit 002 (mode: after)

Date: 2026-10-21. Scope: every screen added in Phase 3 (workspace, members, plan, billing, templates, content library, ranking, quiz, survey, security, audit log, settings, operator console, pricing, terms and privacy), in English and Indonesian, light and dark, at 360 and 1280px. Direction: `DESIGN.md` (Warm editorial, ENERGY 2 / RHYTHM 2 / MOTION 1). Priority follows rule tier: Hard Gate = HIGH, Purpose-Gate = MEDIUM, Quality Locks = LOW. The owner pre-approved fixing every HIGH and MEDIUM finding.

Method:
- Rule-by-rule grep and read of `app/globals.css`, `lib/i18n/en.ts`, `lib/i18n/id.ts`, `lib/legal.ts`, `lib/pricing.ts` and the Phase 3 components (hex colours outside the tokens, gradients, blur, shadows, stripes, radius, uppercase and tracking, em dashes, exclamation marks, emoji, arrows, buzzwords, generic CTAs, inline styles, motion).
- A real-browser run (`scripts/ralph/screens/us031-axe.mjs [en|id] [360|1280]`): axe-core with WCAG 2 A/AA and 2.1/2.2 AA plus best-practice rules, colour contrast on, over about 75 pages and states per run, each in light and dark, plus a layout probe (overflow, clipped text, targets under 44px) and a full-page screenshot. Pages: public (home, login, sign-up, forgot, pricing, terms, privacy, join, bad verify/reset/invite links), participant and presenter screens for poll, word cloud, open text, rating, ranking, shared notes, quiz (nickname, options, sent, result, podium), Q&A and survey (open, error, done, results), and host pages (dashboard, event, Add content menu and every builder, save as template, template picker, moderation, members with a pending invitation, plan, settings with branding, templates, audit log, security, password, delete account, suspended, operator console, operator activity, operator workspace).
- A keyboard walkthrough (`us031-keyboard.mjs`) of invite (host dialog and the invitee's accept page), quiz play, ranking and 2FA enrolment plus 2FA login, using only Tab, Shift+Tab, Enter, Space and arrows after the page loads.
- A reduced-motion check (`us031-motion.mjs`).
- Screenshots at 360 and 1280px were read; they are in `scripts/ralph/screens/us031-*` (gitignored).

| # | Priority | Rule | Finding |
|---|----------|------|---------|
| 1 | HIGH | R-38, R-36 | The plan page and the event page offered features that do not exist. The plan page listed "Image storage" with a usage meter, "N GB of image storage" and "Reports as CSV, PDF, XLSX" on every tier; the event page showed locked "Export PDF" and "Export XLSX" links to Free hosts. Image upload and PDF/Excel export are not built (`docs/launch-checklist.md`, "Not built"), and the public pricing page already left them out. |
| 2 | HIGH | R-32, R-25 | The theme toggle's accessible name ("Dark theme") did not contain its visible text ("Light" while the page is light). axe `label-content-name-mismatch` (serious, WCAG 2.5.3) on every page that has the header, which is almost every page, in both languages. |
| 3 | MEDIUM | R-01, R-29 | Native radio buttons and checkboxes drew the browser's default system blue (settings, retention, language, 2FA requirement, poll and rating choices, quiz multi-select, survey). That blue is in no token and ignored the workspace brand accent. |
| 4 | MEDIUM | R-24, R-32 | The host navigation has up to nine links and nothing said which page you are on, visually or for a screen reader (`aria-current`). |
| 5 | MEDIUM | R-32 | Quiz nickname: pressing Enter in the first-time nickname form unmounted the form and focus fell to the top of the page, so a keyboard user had to Tab back through the header to reach the answers. |
| 6 | MEDIUM | Part 1 "Colored Left Stripe" | `.security-required` (the "your workspace requires 2FA" notice) had a 4px left border and `.delete-account-blocking` had a 4px left border in the error colour. The text carries the meaning; the stripe was decoration. |
| 7 | LOW | R-26 | The "Operator activity" link on `/ops` was 19px high at both widths. |
| 8 | LOW | R-31 | `--quiz-1` to `--quiz-6` (six hues) were in `globals.css` but not in `DESIGN.md`, which says "one accent". The reason (each answer needs its own colour, with shape and label as the other cues) was not written down. |
| 9 | LOW | R-31 | `.security-qr` has `background: #fff` without the reason that `.present-qr` carries (a scanner needs dark modules on a light field in dark theme). |
| 10 | LOW | R-12, R-31 | `.ui-dialog` (`rgb(0 0 0 / 0.25)`) and `.add-menu-list` (`rgb(0 0 0 / 0.14)`) shadows are literals; no shadow token exists. Both are the only floating elements, so the shadow is allowed. Left. |
| 11 | LOW | Part 1 "Colored Left Stripe" | `.present-qa-item` has a 4px left border (accent when pinned). Pre-dates Phase 3; the "Pinned" badge carries the state. Left. |
| 12 | LOW | R-05 | Participant pages keep the host header links ("Events", "Join"). Pre-dates Phase 3; both links work. Left. |
| 13 | LOW | R-05 | `.site-nav a` has `min-width: 44px`, so a short label such as "Plan" leaves an uneven gap before the next link. Left: it keeps the 44px target. |

## Checked, no finding
- R-02/R-16: no em dashes, exclamation marks, emoji or buzzwords in `en.ts`, `id.ts`, `legal.ts` or `pricing.ts`. "Unlock" is a link to the plan page that names the tier, not a default CTA.
- R-15: CTAs are specific ("Start with Free", "Sign up, then upgrade to Pro", "Send ranking", "Save nickname", "Turn on").
- R-17/R-18/R-36 (rest): no statistics, testimonials or compliance claims. Terms and privacy carry a visible placeholder banner until the owner supplies reviewed text (`tests/legal.test.tsx` enforces it).
- Pricing: three stacked rows, no highlighted tier, no "Most Popular" badge, prices only from `PLANS`/`PLAN_PRICES`.
- R-01/R-07/R-10/R-13: no gradients, blur, glow, grids or orbs. R-04/R-08/R-22: no icon set, no illustrations; the arrows are reorder buttons and the stars are the rating control, both functional.
- R-11: radius scale 4px and 8px; the only `50%` is the spinner.
- R-19: transitions 150 to 250ms, one entrance animation (podium). With `prefers-reduced-motion: reduce` no screen runs an animation or transition longer than 1ms (`us031-motion.mjs`: podium, quiz countdown, presenter bars); without it the podium animation, bar widths and countdown run, so the check does measure something.
- R-34: both themes render on every screen listed above; no overflow at 360px (`doc=false`, no element past the viewport, no clipped button or link text) in English or Indonesian.
- R-27: loading, error, empty and locked states exist on the new screens (survey error, quiz time up, empty audit log, locked branding, plan hints, nickname taken).
- R-32: keyboard walkthrough of invite, quiz play, ranking and 2FA login completes with Tab, Enter, Space and arrows only; every stop had a visible focus ring and a name; the 2FA code step and the invite dialog take focus on open; the ranking move buttons keep focus after a reorder.
- Comments: added comments state constraints or reasons.
