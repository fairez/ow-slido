# OW Slido

A Slido-style live audience interaction app: hosts create events with polls, word clouds, shared notes, open text, ratings and moderated Q&A; participants join by code on their phones; a presenter page shows results live.

Stack: Next.js (App Router) + TypeScript, PostgreSQL (Drizzle ORM), Socket.IO via a custom Node server. Node 22.

## Setup

1. `npm install`
2. Create `.env.local` (gitignored) from `.env.example`:

   | Variable | Purpose | Production |
   | --- | --- | --- |
   | `DATABASE_URL` | Postgres URL for the dev/production database | Yes |
   | `TEST_DATABASE_URL` | Postgres URL for the test database (unit and e2e tests) | Never |
   | `SESSION_SECRET` | Signs host login sessions; changing it logs everyone out | Yes |
   | `PARTICIPANT_TOKEN_SECRET` | Signs participant tokens (a different value from `SESSION_SECRET`) | Yes |
   | `ALLOW_SIGNUP` | `false` closes public sign-up | Strongly recommended |
   | `ALLOWED_DEV_ORIGINS` | Extra hosts allowed to load `next dev` assets | Never |
   | `AI_PROVIDER` | `openai`, `openrouter` or `mock`; unset hides all AI features | For AI (never `mock`) |
   | `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | Key for the chosen provider | For AI |
   | `AI_MODEL` | Model override; empty uses the provider default | No |
   | `AI_EVENT_CALL_CAP` / `AI_DAILY_CALL_CAP` | AI calls per event (default 20) and in total per UTC day (default 200) | No |
   | `AI_GLOBAL_DAILY_CAP` | Hard stop for AI calls per UTC day across all workspaces (default 1000, `0` pauses AI) | Set it to your budget |
   | `EMAIL_PROVIDER` | `smtp` sends mail; empty or `log` keeps it in memory only | Yes, for real mail |
   | `EMAIL_FROM` | Sender address when `EMAIL_PROVIDER=smtp` | With smtp |
   | `SMTP_HOST` / `SMTP_PORT` | SMTP server and port (port defaults to 587; 465 uses TLS) | With smtp |
   | `SMTP_USER` / `SMTP_PASSWORD` | SMTP login, only if the server asks for one | If the server needs it |
   | `EMAIL_OUTBOX_FILE` | Log adapter only: also writes each message to this file (the e2e run uses it) | Never |
   | `BILLING_PROVIDER` | `stripe` or `mock`; unset in production means no plan can be bought | Yes |
   | `BILLING_WEBHOOK_SECRET` | Signs the mock provider's events | Only with `mock` in production |
   | `STRIPE_SECRET_KEY` | Stripe API key | With stripe |
   | `STRIPE_WEBHOOK_SECRET` | Signing secret of the Stripe webhook endpoint | With stripe |
   | `STRIPE_PRICE_PRO_MONTH` / `_PRO_YEAR` / `STRIPE_PRICE_TEAM_MONTH` / `_TEAM_YEAR` | Stripe price id of each plan and interval | With stripe |
   | `TWOFA_ENCRYPTION_KEY` | 32-byte key (64 hex or base64) that encrypts 2FA secrets; without it nobody can enable 2FA | Yes |
   | `OPERATOR_EMAILS` | Comma-separated emails that may open `/ops` (must also be verified) | For an operator |
   | `JOB_RETRY_BACKOFF_MS` | Delays before the 3 retries of a failed background job (default `1000,5000,20000`) | No |
   | `QUIZ_GRACE_MS` | Milliseconds a quiz answer may arrive after the deadline (default 300) | No |
   | `PORT` | Server port (default 3000; Railway sets it) | No |

   `.env.example` lists the same variables with a comment on each. What to set before going live is in [docs/launch-checklist.md](docs/launch-checklist.md).

   With `npm run dev`, values in `.env.local` replace variables inherited from your shell (the server logs which ones it replaced). With `npm start` the real environment wins, so hosting settings are not overridden.

3. Apply migrations: `npm run db:migrate` (and `npm run db:migrate:test` for the test DB).
4. `npm run dev`, then open http://localhost:3000 (`PORT` overrides the port).

## Deploy

Railway: see [docs/deploy-railway.md](docs/deploy-railway.md) (config in `railway.json`). In production set `ALLOW_SIGNUP=false` after the first admin exists, and run a single instance (realtime and rate limits are in memory).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Custom server (Next.js + Socket.IO) in dev mode |
| `npm run build` / `npm start` | Production build / production server |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest unit and integration tests (DB tests need `db:migrate:test` first) |
| `npm run test:e2e` | Playwright end-to-end tests against the test DB |
| `npm run db:generate` | Generate a migration after editing `db/schema.ts` |
| `npm run db:migrate[:test]` | Apply migrations to the dev / test DB |
| `npm run db:reset:test` | Drop and recreate the test DB schema, then migrate |

### End-to-end test

`npm run test:e2e` starts its own server on port 3100 with `DATABASE_URL` pointed at `TEST_DATABASE_URL` and a separate Next build dir (`.next-e2e`), so it can run next to `npm run dev`. It signs up a host, creates an event and a poll, starts it, joins as a participant by code, votes, and checks the result on the presenter page.

A second spec (`e2e/notes-ai.spec.ts`) covers shared notes: two participants add and upvote notes, the host moderates and runs Analyze, the presenter page shows the categories, then an open text round and a rating round run. The e2e server starts with `AI_PROVIDER=mock`.

Playwright needs a Chromium build: `npx playwright install chromium`. If a different build is already on disk, set `PW_CHROMIUM_PATH` to its executable.

## Interaction types

- **Poll**: single or multiple choice, with live results.
- **Word cloud**: each participant submits a limited number of short entries.
- **Interaction states**: draft, live, paused, closed. Starting a new interaction pauses the live one instead of closing it (one live per event); a paused interaction stops taking answers and can be resumed or closed. Closed ones cannot be restarted; duplicate them.
- **Shared notes**: participants post notes (up to 5000 characters) and upvote each other's. Hosts choose open or moderated mode (moderated notes wait for approval), the notes allowed per participant, and whether author names show. Notes can be pinned, rejected or deleted, and exported in CSV.
- **Open text**: free-text responses that the host can highlight or hide; the presenter page lists them.
- **Rating**: a 1 to 5 star or 1 to 10 scale, shown as a distribution with the average.

## AI analysis (Shared Notes)

Hosts can analyze the approved notes of a Shared Notes interaction: a summary, categories and keywords. The analysis is started manually by the host with the Analyze button. It never runs on its own. The host can review and edit the result, then choose whether to publish it to participants. Participants see a notice that AI is used, and the host confirms that note text is sent to a third-party service before the first run. Results export in the event CSV.

Configure it with the `AI_*` variables above. The platform owner's key belongs only in `.env.local`, which is gitignored; never commit it or put it in client code. Calls are capped per event and per day (`AI_EVENT_CALL_CAP`, `AI_DAILY_CALL_CAP`). With no provider configured the AI controls are hidden and the presenter shows a plain word-frequency cloud.

`AI_PROVIDER=mock` swaps in a deterministic fake that makes no network calls. Use it for development, tests and e2e runs; tests must never call a real AI API.

## Billing

Payments sit behind a `BillingProvider` interface (`lib/billing/`). `BILLING_PROVIDER=mock` is the default outside production: checkout is a signed link to a local route, and state changes arrive as HMAC-signed webhooks through the same `POST /api/billing/webhook` a real provider would call. In production the variable has no default, so set it explicitly; with it unset, the billing routes answer 503 and no paid plan can be bought. Set `BILLING_WEBHOOK_SECRET` (required in production). Webhooks are verified, recorded once per provider event id, and are the only way a subscription changes. Canceling keeps paid access until the period end. Tests and e2e use the mock and never reach the network. Real payments use `BILLING_PROVIDER=stripe`; setup for test-mode keys, prices and the webhook URL is in `docs/billing.md`.

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
