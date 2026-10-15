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
