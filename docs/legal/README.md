# Legal text

`/terms` and `/privacy` render placeholder text with a visible banner ("Placeholder text, supplied by the project owner").
The words live in `lib/i18n/en.ts` and `id.ts` under `legal.*`; the section lists are in `lib/legal.ts`.

When the project owner has supplied and reviewed the final text in both languages:

1. Replace the `legal.terms.*` and `legal.privacy.*` copy.
2. Remove the banner block (`data-legal-placeholder`) from `components/legal-page.tsx`.
3. Create the file `docs/legal/REVIEWED` (any content, for example the reviewer and the date).

`tests/legal.test.tsx` fails when the banner is gone and `docs/legal/REVIEWED` does not exist, so the banner cannot be dropped by accident.
The privacy text states facts about the product (what is stored, AI analysis, deletion, retention). Change it in the same commit as the behaviour it describes.
