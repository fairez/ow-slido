# OW Slido

A Slido-style live audience interaction app: hosts create events with polls, word clouds and moderated Q&A; participants join by code on their phones; a presenter page shows results live.

Stack: Next.js (App Router) + TypeScript, PostgreSQL (Drizzle ORM), Socket.IO via a custom Node server. Node 22.

## Setup

1. `npm install`
2. Create `.env.local` (gitignored) from `.env.example`:

   | Variable | Purpose |
   | --- | --- |
   | `DATABASE_URL` | Postgres URL for the dev/prod database |
   | `TEST_DATABASE_URL` | Postgres URL for the test database (unit and e2e tests) |
   | `SESSION_SECRET` | Signs host login sessions |
   | `PARTICIPANT_TOKEN_SECRET` | Signs participant tokens |

3. Apply migrations: `npm run db:migrate` (and `npm run db:migrate:test` for the test DB).
4. `npm run dev`, then open http://localhost:3000 (`PORT` overrides the port).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Custom server (Next.js + Socket.IO) in dev mode |
| `npm run build` / `npm start` | Production build / production server |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest unit and integration tests (DB tests need `db:migrate:test` first) |
| `npm run test:e2e` | Playwright smoke test against the test DB |
| `npm run db:generate` | Generate a migration after editing `db/schema.ts` |
| `npm run db:migrate[:test]` | Apply migrations to the dev / test DB |
| `npm run db:reset:test` | Drop and recreate the test DB schema, then migrate |

### End-to-end test

`npm run test:e2e` starts its own server on port 3100 with `DATABASE_URL` pointed at `TEST_DATABASE_URL` and a separate Next build dir (`.next-e2e`), so it can run next to `npm run dev`. It signs up a host, creates an event and a poll, starts it, joins as a participant by code, votes, and checks the result on the presenter page.

Playwright needs a Chromium build: `npx playwright install chromium`. If a different build is already on disk, set `PW_CHROMIUM_PATH` to its executable.

## Architecture

- `app/`: pages (`/dashboard`, `/present/[eventId]`, `/e/[eventId]`, `/join/[code]`, `/moderate`, auth pages) and route handlers under `app/api/`.
- `server.ts`: HTTP server that hands requests to Next.js and attaches Socket.IO at `/socket.io`.
- `lib/realtime/`: Socket.IO server, `publish()` used by route handlers to broadcast results, in-memory presence tracking.
- `db/`: Drizzle schema, generated SQL migrations, client factory.
- `lib/`: auth, rate limiting, interaction state machine, CSV export and other domain logic.
- `components/`: client components for the host dashboard, participant view and presenter view.
- `tests/`: Vitest tests, including axe accessibility checks. `e2e/`: Playwright tests.

### Redis

Redis is optional and not used yet. The rate limiter and the realtime publisher sit behind interfaces with in-memory implementations (`setRateLimitStore`, `setPublisher`), and presence is held in process memory. This is correct for a single server process; running several processes would need a shared store and a Socket.IO adapter.
