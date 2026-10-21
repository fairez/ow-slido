# Mobile audit

Method: `scripts/ralph/screens/us030.mjs` (Playwright, Chromium) loads every page at 360px, 390px and 768px with deliberately long content (140-character unbroken words in the event name, prompts, options, word cloud entries, open-text responses, notes and questions). For each page it checks document horizontal scroll, any element extending past the viewport or scrolling internally, and every link, button and form control under 44x44px. Screenshots are reviewed at 360px and 1280px.

## Pages checked
- Home (join code), `/login`, `/signup`, `/join/:code`
- Host dashboard, event page (interaction list, forms, moderation panel)
- Participant screens: waiting, poll, word cloud, rating, open text, shared notes, Q&A
- Presenter view: poll, word cloud, rating, open text, shared notes
- Moderator link page

## Findings and fixes
| Finding | Fix |
|---|---|
| Header "Join" link 28px wide | `min-width: 44px` on nav links |
| Site name link 31px tall | Inline-flex with `min-height: 44px` |
| Skip link 41px tall when focused | Padding and `min-height: 44px` |
| Inline "log in" / "Create a host account" links on home 41px tall | Block-level padding so the tap area is 44px |

## Result
No horizontal scroll at 360, 390 or 768px on any page, including with long unbroken words. No clipped content. All interactive targets measure at least 44px in both dimensions after the fixes. Layouts reflow through the 600-1024px range without a stretched stack because page content is capped by max-width containers.

## Indonesian pass (US-026)
Method: `scripts/ralph/screens/us026-id.mjs [360|1280]` runs the production build against the test DB with the browser, the host account (`users.locale = id`) and the event audience language set to Indonesian. Every page below is loaded in light and dark; each load checks document horizontal scroll, elements past the viewport, text wider than its box (buttons, links, labels, selects, `overflow: hidden` boxes) and every control under 44x44px. Screenshots are saved as `scripts/ralph/screens/us026-id-<page>-<scheme>-<width>.png` (gitignored) and were reviewed at both widths.

Pages: home, login, sign-up, forgot password, join (cookies blocked), participant waiting, participant poll / word cloud / open text / rating / ranking / shared notes / quiz (nickname, options, sent, result) / Q&A / survey (form, error, done), presenter live and closed for every type plus podium, Q&A and survey results, host dashboard, event page, Add content menu and each of its nine builders, save-as-template dialog, template picker, moderation, members, plan, settings, templates, audit log, security, password.

| Finding (Indonesian, before) | Fix |
|---|---|
| Audit log "Semua tindakan" select clipped at 1280 (four columns in a 688px page) | Filter grid is `repeat(auto-fit, minmax(min(100%, 15rem), 1fr))`: two columns on the event-width page, one on a phone |
| "Hapus akun Anda" link on the security page 19px tall | The link is `inline-flex` with `min-height: 44px` |
| Add content menu items "Catatan bersama baru" and "Pertanyaan kuis baru" wrapped to two lines | Menu is `width: max-content` (min 14rem, max 22rem or the viewport), so labels stay on one line |

## Result
After the fixes: no horizontal scroll, no element past the viewport, no clipped text and no control under 44px at 360px or 1280px, light or dark, on any page above, and no page errors. Rows on the event page still wrap their action buttons (Duplikat, Simpan sebagai templat, the move arrows) onto a second line at 360px; nothing is cut off, so the copy stays as written. Native date inputs show `mm/dd/yyyy` in Chromium whatever the page language, because the browser's own locale sets that format. The presenter's floating controls sit over the content in a full-page screenshot at 360px; they are fixed to the viewport by design.
