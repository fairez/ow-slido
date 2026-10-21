# Launch checklist

Work through this before real people use a deployment. Variable meanings are in `.env.example` and the README; Railway steps are in `docs/deploy-railway.md`. Put secrets only in the host's variables or `.env.local`, never in the repo or in this file.

## 1. Core settings

- [ ] `DATABASE_URL`, `SESSION_SECRET` and `PARTICIPANT_TOKEN_SECRET` are set. The two secrets are different long random values (`openssl rand -hex 32`).
- [ ] `/api/health` answers 200 with `"status":"ok"` (database reachable, migrations applied).
- [ ] Postgres backups are on.
- [ ] One replica only. Realtime and rate limits live in process memory.
- [ ] Sign-up policy decided. `ALLOW_SIGNUP=false` closes `/signup` for everyone, including customers who follow the pricing page; leave it unset only if public sign-up is the plan. Invited people can still accept an invitation.

## 2. Stripe (test mode first)

Full steps and the event mapping are in `docs/billing.md`.

- [ ] Products Pro and Team exist in Stripe test mode, each with a monthly and a yearly price in the currency of `PLAN_PRICES` (`lib/plans.ts`).
- [ ] `BILLING_PROVIDER=stripe`, `STRIPE_SECRET_KEY` (test key), and the four `STRIPE_PRICE_*` ids are set.
- [ ] Customer portal is on, with cancel at period end and payment-method update allowed.
- [ ] Webhook endpoint `https://<your domain>/api/billing/webhook` listens to `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`; its signing secret is `STRIPE_WEBHOOK_SECRET`.
- [ ] Test purchase with the Stripe test card: the plan page shows the new plan, the webhook shows as delivered in Stripe, and canceling keeps access until the period end.
- [ ] Repeat the first five items with live-mode objects and keys, then run one real low-value purchase and refund it.
- [ ] If you launch without Stripe: leave `BILLING_PROVIDER` unset in production so the billing routes answer 503. Do not use `mock` on a public deployment.

## 3. Email

- [ ] `EMAIL_PROVIDER=smtp`, `EMAIL_FROM`, `SMTP_HOST` (and `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` if the server needs them) are set. With `log` (the default) no email leaves the server: nobody can verify an address, accept an invitation or reset a password.
- [ ] The sender domain has SPF and DKIM set up, so verification and invitation mail does not land in spam.
- [ ] Sign up with a test address and confirm the verification mail arrives. Invite a second address and confirm that mail too.

## 4. Legal text

- [ ] The project owner has supplied the final Terms and Privacy text in English and Indonesian. The shipped text is a placeholder.
- [ ] The `legal.terms.*` and `legal.privacy.*` copy is replaced, the banner (`data-legal-placeholder`) is removed from `components/legal-page.tsx`, and `docs/legal/REVIEWED` is created (steps in `docs/legal/README.md`). `tests/legal.test.tsx` fails if the banner goes without that file.
- [ ] The privacy text still matches the product: what is stored, AI analysis of approved notes, deletion routes, retention periods.

## 5. Operators and accounts

- [ ] `OPERATOR_EMAILS` lists the people who may open `/ops`. Each of them has a verified email and no pending password change, otherwise `/ops` stays a 404 for them.
- [ ] `TWOFA_ENCRYPTION_KEY` is set (64 hex characters) and stored somewhere safe. Rotating it invalidates every stored 2FA secret and recovery code.
- [ ] Operators turn on 2FA for their own accounts.

## 6. AI

Skip this section if AI stays off (`AI_PROVIDER` empty hides every AI control).

- [ ] `AI_PROVIDER` is `openai` or `openrouter` (never `mock`) and the matching key is set.
- [ ] Caps match the budget: `AI_EVENT_CALL_CAP`, `AI_DAILY_CALL_CAP` and `AI_GLOBAL_DAILY_CAP`. The effective daily limit is the lower of the last two; `AI_GLOBAL_DAILY_CAP=0` pauses AI.
- [ ] One analysis on a test event works, and the provider's bill moves by the expected amount. `/ops` shows today's calls against the global cap. Nothing alerts anyone when the cap is reached, so look there.

## 7. Retention

- [ ] Decide the default to recommend to customers. A new workspace has no retention set, so its events are kept until the owner deletes them. Owners and admins choose 30, 90 or 365 days on `/dashboard/settings`.
- [ ] If you recommend a period, the privacy text names the same periods (it is filled from `RETENTION_OPTIONS` in `lib/retention-schedule.ts`).
- [ ] The daily jobs ran: `/api/health` shows `dailyJobs` for `subscriptions` and `retention` with a recent finish time.

## 8. Final pass

- [ ] Join an event from a phone on mobile data and vote; the result shows on the presenter page.
- [ ] Switch an event to Indonesian and check the join screen.
- [ ] Open `/pricing`, `/terms` and `/privacy` signed out.
- [ ] Check the deploy logs for `migrated DATABASE_URL: ...` and for startup errors about missing configuration.

## Not built in this run

These are in the plans or the product spec but do not exist yet. Nothing in the app depends on them, and the public pricing page leaves them out. Do not promise them to customers.

- **Images in content.** `imageStorageMb` is a plan limit with no upload or storage behind it.
- **PDF and Excel reports.** The limits list `pdf` and `xlsx`; only CSV (and the ZIP of CSVs) is built.
- **AI Insights.** AI analysis of Shared Notes exists; the wider Insights feature does not.
- **Workspace logo.** Branding is the accent colour only. The logo waits for image storage (`docs/branding.md`).

## Known gaps

- No screen for the workspace data export; the API (`POST /api/workspace/export`) works.
- No way to regenerate 2FA recovery codes. A member who loses them asks an operator for a 2FA reset.
- No alert when the global AI cap is reached (see section 6).
- Redis is not used; do not add replicas until the rate limiter and realtime publisher have a shared adapter.
