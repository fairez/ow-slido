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
