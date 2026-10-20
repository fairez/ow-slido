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

## Workspaces
- Events belong to a workspace (`events.workspace_id`, NOT NULL, cascade); `events.owner_id` is only the creator. Users reach workspaces through `memberships`.
- Every data table must reach a workspace through `events` (or `interactions`, which reach `events`), so deleting a workspace removes everything. A table that holds workspace-level data (not event data) references `workspaces` directly with `onDelete: "cascade"`.
- Access: `requireMember(request)` (`lib/auth/require-admin.ts`) resolves the active workspace (cookie `workspace`, else first active membership) and returns `{user, workspaceId, role}`; use `getSessionMember` where anonymous callers are also allowed. Find events with `findOwnedEvent(id, auth.workspaceId)`; pages and the socket server use `resolveActiveMembership` from `lib/auth/workspace.ts`. Test users who act as hosts or strangers need a workspace (`workspaceFor`), else they get 403.
- Tests that insert events directly need `workspaceId: await workspaceFor(db, user.id)` from `tests/helpers/db.ts`. In routes, `lib/workspaces.ts` has `createPersonalWorkspace` and `firstWorkspaceId`.

- Members: `lib/members.ts` holds the rules (admins cannot touch owners or grant owner, last active owner is protected under a row lock, no self-suspend) behind `/api/members` routes. Changing a role, suspending or removing a member also calls `revokeMemberSockets` (lib/realtime/publisher.ts) so their live host sockets drop; HTTP access ends on the next request because memberships are read per request.

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

## i18n
No inline UI strings in new code. Add the key to `lib/i18n/en.ts` and `id.ts`, then use `t()`, `getT()` (server) or `useT()` (client). Details in `docs/i18n.md`.

## Sessions and passwords
- Session tokens are `userId.issuedAtMs.expires.sig`; `getUserFromToken` rejects tokens issued before `users.sessions_valid_after`. Changing or resetting a password goes through `setPassword` (lib/auth/password-reset.ts), which sets that column, clears `must_change_password` and must be followed by a fresh `sessionSetCookie` for the current device.
- While `must_change_password` is true, `requireAdmin`/`requireMember` return 403 `{reason: "password_change_required"}`, `getSessionMember` returns null, and server pages redirect to `/account/password`. A route that calls `getSessionUser` directly must call `denyIfPasswordChangeRequired` unless it is `/api/auth/me`, logout or the change-password route.

## Plans
- `lib/plans.ts` is the only place that defines tiers (`PLANS`, `PLAN_PRICES`, `PAST_DUE_GRACE_DAYS`) and the only way to read limits is `getEntitlements(workspaceId)`; never read `subscriptions` directly for a limit. A workspace with no `subscriptions` row is Free, so new workspaces need no row. Month boundaries come from `utcMonthBounds()`.
- Limits: `lib/limits.ts` (`assertTypeAllowed`, `assertCanCreateEvent`, `PlanLimitError`, `planLimitResponse`) and `lib/seats.ts` (`assertSeatAvailable`) throw `PlanLimitError`; routes catch it and return 402 `{error, reason, requiredPlan}`. New limit checks follow that shape. Usage limits live in `lib/limits.ts` too: `assertParticipantSlot` (join route, 403 with the message only, no upgrade hint, under a per-event advisory lock), `assertAiCallsAvailable` (analyze start; the env caps in `lib/ai/usage.ts` still apply) and `assertReportFormat` (export). Tests narrow `PLANS.<tier>` for one case and restore it in `afterEach`; analysis tests and e2e need `setPlan(..., "pro")` / `setPlanFor(email, "pro")` because Free has no AI calls. Tests that need more than Free allows (invites, members, many events) call `setPlan(db, workspaceId, "team")` from `tests/helpers/db.ts`.
- Locked hints: a gated control stays visible as `<PlanHint lock={{requiredPlan}}>` (components/plan-hint.tsx, a link to `/dashboard/plan` that names the tier). Server pages build the locks from `getEntitlements(...).limits` with `lockedTypes`, `lockedFormats`, `aiLock`, `seatLock` (lib/plan-hints.ts) and pass them down; client components never import `lib/plans` values. Usage numbers for the plan page come from `getUsage` (lib/usage.ts).

## Billing
- `lib/billing/`: `BillingProvider` (createCheckout, createPortalSession, cancelSubscription, parseWebhook), selected by `getBillingProvider()` from `BILLING_PROVIDER` (unset = mock outside production, none in production → routes answer 503). Subscription state changes only through `receiveWebhook` (verify signature, then `applyBillingEvent`: one transaction, `billing_events` unique on provider + event id, upsert on `subscriptions.workspace_id`, plan overrides untouched). Nothing else writes `plan`/`status`/`current_period_end`.
- The mock signs events with HMAC (`x-mock-signature`, secret `BILLING_WEBHOOK_SECRET`; a dev default exists only outside production). Checkout is a signed link to `GET /api/billing/mock/complete`, which sends a signed webhook to itself. Cancel sets status `canceled` and keeps `current_period_end`, which `resolveEntitlements` already treats as access until the period end.
- Routes under `app/api/billing/` need `billing.manage` (owner only); checkout also needs a verified email. Tests set `BILLING_PROVIDER=mock` and a webhook secret with `vi.stubEnv` (tests/billing.test.ts has a signed-webhook helper). A new provider returns a `BillingEvent` from `parseWebhook` and nothing else.
