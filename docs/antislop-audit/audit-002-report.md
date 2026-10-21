# antislop audit 002: follow-up report

Fixed findings 1 to 9. Items 10 to 13 left as LOW (reasons in `audit-002.md`).

## Fixes
1. `PlanOverview` no longer shows the image-storage meter or the "image storage" and "Reports as ..." lines; the event page no longer shows locked "Export PDF" and "Export XLSX" links; `lockedFormats`, its test and the six i18n keys (`plan.usage.storage`, `plan.fact.storage`, `plan.fact.noStorage`, `plan.fact.reports`, `dash.exportPdf`, `dash.exportXlsx`) are gone from both languages. `tests/plan-overview.test.tsx` now checks that none of the unbuilt features is mentioned. They come back with the features (`docs/launch-checklist.md`, "Not built").
2. `ThemeToggle` shows "Dark theme" (or "Tema gelap") as its text, which is also its name, and shows the state with `aria-pressed` and inverted colours. While fixing it the full axe output turned up three more label-in-name mismatches that a first run had hidden behind a filter I had written: "Save as template: {title}" (was "Save {title} as a template"), the Q&A and shared-notes upvote button ("Upvote: {text}. Upvotes: {n}", because the visible text is the count, and a bracketed "(1)" does not match it), and the Indonesian "Tambah pilihan ke pertanyaan {n}" in the survey builder (the visible word is "pilihan", the label said "opsi"). Tests pin the new names.
3. `accent-color: var(--accent)` on checkboxes and radios; they follow the workspace brand accent as well.
4. New `NavLink` (`components/ui/nav-link.tsx`): `aria-current="page"` plus a bold, underlined link. `tests/nav-link.test.tsx` covers Events (also current under `/dashboard/events`, not under other dashboard pages), prefix matching and the home link.
5. After the first-time nickname is saved, focus moves to "Playing as X" (`quiz-form.tsx`); `tests/quiz-ui.test.tsx` asserts it.
6. Stripes removed: `.security-required` is a plain bordered notice; `.delete-account-blocking` has a full `--error` border.
7. "Operator activity" uses `.back-link` (44px high).
8. `DESIGN.md` now says why the quiz has six answer colours and how they are checked.
9. `.security-qr` carries the same comment as `.present-qr`.

## Verification
- axe (WCAG 2 A/AA, 2.1 and 2.2 AA, best-practice, colour contrast on), light and dark, over the pages listed in `audit-002.md`: English 1280, Indonesian 1280, English 360 and Indonesian 360 each run once on the build before the last label fixes, and the two rules left over were rerun on the final build: the Q&A page in English and Indonesian at 1280 (0 violations) and the Indonesian survey builder at 360 (0 violations). The first runs, before any fix, had the theme toggle (every page) and the label mismatches above; nothing else was reported: no colour-contrast, landmark, heading, form-label or ARIA violation in any language, theme or width.
- Layout probe at 360px, English and Indonesian: no horizontal overflow, no element past the viewport, no clipped button or link text, no control under 44px after fix 7.
- Keyboard walkthrough (`us031-keyboard.mjs`, final build): invite (host dialog then the invitee creating an account), quiz play (join code, nickname, answer), ranking (reorder with Enter and Space, send) and 2FA (enrol, confirm, recovery screen, log in with the code) all complete with the keyboard alone; every stop had a visible focus ring and a name, and focus landed in the dialog or on the next step each time.
- Reduced motion (`us031-motion.mjs`): with `prefers-reduced-motion: reduce` the participant quiz, the presenter quiz and the podium run no animation or transition longer than 1ms; without it the countdown bar, bar widths and the podium rise run.
- Screenshots at 360 and 1280px in both themes were read after the fixes (settings, members, plan, security, pricing, ranking, quiz result); they match `DESIGN.md`.

## Delivery Gate
- Hard Gate: PASS. R-03: no overflow at 360px. R-25: axe colour contrast clean in light and dark, English and Indonesian. R-26/R-27: controls call real endpoints; loading, error, empty and locked states exist. R-32: keyboard walkthrough above. R-34: both themes checked on every screen. R-35: built and run in a browser, no console errors in the runs. R-36/R-38: the unbuilt-feature claims are gone.
- Purpose-Gate: PASS. No gradients, glow, blur, icons beyond functional arrows and stars; accent still marks the primary action, the pressed state and the current page; the six quiz colours are justified in `DESIGN.md`.
- Liveliness: PASS. Dials ENERGY 2 / RHYTHM 2 / MOTION 1 unchanged; serif headings, warm palette.
- Craftsmanship: PASS.

## LOW items left
- 10 shadows without a token, 11 stripe on the pinned presenter question, 12 host header links on participant pages, 13 gap after short nav labels. See `audit-002.md`.
- Not a finding of this audit: `npm run lint` (all of `.`) reports errors only in the gitignored scratch scripts under `scripts/ralph/screens/`; `eslint lib tests db app components e2e` is clean.
