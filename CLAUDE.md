# OW Slido — project notes for agents

- Product spec: `tasks/prd-slido-clone.md` (MVP). Stories live in `scripts/ralph/prd.json`; progress log is `scripts/ralph/progress.txt`.
- Stack: Next.js (App Router) + TypeScript, PostgreSQL, Socket.IO via a custom server. Node 22.
- Environment: Postgres 16 on localhost. Dev DB `ow_slido`, test DB `ow_slido_test`, credentials in `.env.local` (gitignored, never commit or print it). Do not touch other databases on this Postgres server.
- Redis and Docker are NOT installed. Use in-memory adapters behind interfaces (rate limiter, pub/sub); do not try to install system packages.
- Use only the npm registry for dependencies; no global installs.
- Run `npm run lint`, `typecheck`, `test` before every commit.

## Database commands
- Drizzle ORM + `pg`. Schema in `db/schema.ts`, generated SQL in `db/migrations/`, client factory in `db/client.ts` (`createDb(url)`).
- `npm run db:generate` — generate a migration after editing the schema (commit the output).
- `npm run db:migrate` — apply migrations to `DATABASE_URL`; `npm run db:migrate:test` — to `TEST_DATABASE_URL`.
- `npm run db:reset:test` — drop and recreate the test DB's schemas, then migrate (refuses to run on the dev DB).
- Tests that hit the DB: start the file with `// @vitest-environment node`, use `createTestDb()` and `truncateAll(db)` in `beforeEach` from `tests/helpers/db.ts`. Run `db:migrate:test` first after adding migrations.

## Interactions
- Types: `poll`, `wordcloud`, `sharedNotes`, `openText`, `rating`. Config for the last three is validated in `lib/interaction-config.ts` (hand-written parsers; no zod). Adding a type means updating the `db/schema.ts` enum and check, the create/PATCH/duplicate routes and a migration.
- Every table that holds event data (responses, notes, analyses...) must reference `interactions` or `events` with `onDelete: "cascade"`, so deleting an event removes it. Add a cascade test for each new table.

## E2E
- `npm run test:e2e` (Playwright, `e2e/`) boots its own server on :3100 against the test DB with `NEXT_DIST_DIR=.next-e2e`. If Playwright's expected Chromium isn't installed, set `PW_CHROMIUM_PATH` to an existing chrome-headless-shell binary (no browser downloads here).

## AI analysis (Shared Notes)
- Provider-agnostic server client for OpenAI and OpenRouter. Env: `AI_PROVIDER` (`openai` | `openrouter` | `mock`), `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `AI_MODEL`, `AI_EVENT_CALL_CAP`, `AI_DAILY_CALL_CAP`. The key belongs to the platform owner and lives only in `.env.local`.
- NEVER call a real AI API from tests, e2e or Ralph runs: use `AI_PROVIDER=mock` (deterministic fake) or mock `fetch`. Never print, log or commit keys or note text.
- Client lives in `lib/ai` (`complete(messages, schema, {eventId})`); caps are tracked in `ai_calls`. Hide AI UI with `isAiConfigured()`; never import `lib/ai` from client code.
- Analysis is started manually by a host only. Never run it automatically.

## Browser verification (dev-browser is not installed)
For UI stories, verify with Playwright (Chromium is installed): start your own server with `NEXT_DIST_DIR=.next-shot PORT=3200 npm run dev` (the user may have `npm run dev` running on 3111; do not stop it), drive the page with a small script, save screenshots at 360px and 1280px wide to `scripts/ralph/screens/` (gitignored), then Read the screenshots and fix what looks wrong. Kill your own server when done.

## Design and antislop
Direction lives in `DESIGN.md` (Warm editorial, light and dark). All UI work, new or restyled, follows it and the antislop rules. Use semantic CSS variables from the tokens in `DESIGN.md`; do not hardcode colours.
Antislop mode is configured by the project owner: `during` for every story, `after` for the final audit story. Do not ask the user which mode; do not run the install wizard (it is already installed). The final audit story pre-approves fixing every HIGH and MEDIUM finding.

<!-- antislop:start -->
## antislop
For UI, copy, people, mobile layout, or code comments work, read `docs/antislop/antislop.md` (core) and then the skill for the task:
- UI / visual: `docs/antislop/skills/antislop-ui/SKILL.md`
- Copy & text: `docs/antislop/skills/antislop-copywriting/SKILL.md`
- People: `docs/antislop/skills/antislop-human/SKILL.md`
- Mobile / responsive: `docs/antislop/skills/antislop-layoutmobile/SKILL.md`
- Code comments: `docs/antislop/skills/antislop-code/SKILL.md`
Resolve the mode from the project note above (`during`, or `after` for the final audit story). Direction is `DESIGN.md`.
<!-- antislop:end -->
