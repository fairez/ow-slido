# PRD: Slido Clone — Phase 3: Commercial Product (Tiers, Teams, Content, AI Insights, Localisation)

> **Depends on:** `prd-slido-clone.md` (MVP) and the shipped part of `prd-slido-clone-full.md` (Phase 2a: shared notes, open text, rating, AI note analysis, design system). **This PRD absorbs the unbuilt rest of Phase 2** (admin management, ranking, quiz, survey, images, analytics summary, PDF/Excel reports) so one document describes everything left. Phase 2 story text is restated here, not referenced; story IDs restart at US-001.
>
> **Direction (decided by the project owner):** the product is sold to many customers. Phase 3 adds (1) a unified content model where Q&A, polls, quiz, survey, ranking and the rest are managed the same way, (2) the remaining interaction types and images, (3) tiers with feature and seat limits plus billing, (4) workspaces, roles and branding, (5) AI Insights over everything collected in an event, (6) security and privacy, (7) Indonesian and English UI.
>
> **Assumptions (change if wrong):** three tiers named Free, Pro and Team · Stripe for billing, with a payment-provider interface so an Indonesian provider can be added · the platform owner's single AI key stays, and AI cost is controlled by per-tier caps · "managed like other content" means every interaction type, including Q&A, lives in one library that can be created, edited, reordered, duplicated, templated and exported the same way · original branding, no Slido assets or copy.

## 1. Introduction/Overview

Today a host can run polls, word clouds, Q&A, shared notes, open text and ratings, and can have AI summarise notes. To be sold to many customers it needs: the remaining interaction types, one consistent way to manage all content, accounts that belong to a workspace with several people and roles, paid tiers that gate features and seats, an AI feature that makes a clear impression, and basic enterprise-grade security. The UI must work in Indonesian and English.

## 2. Goals

- One content model: every interaction type (poll, word cloud, Q&A, shared notes, open text, rating, ranking, quiz, survey) is created, ordered, duplicated, saved as a template and exported the same way.
- A workspace owner can invite teammates, assign roles, and pay for a tier; limits are enforced on the server and shown in the UI.
- A host can generate an AI Insights report for a whole event in under 60 seconds that covers every interaction type, and share it.
- Quiz leaderboard updates within 1 second (p95) for 500 participants.
- The whole UI is available in Indonesian and English, chosen per user and per event.
- Admin accounts can enable 2FA; data retention and deletion are configurable per workspace.

## 3. User Stories

### Part A: Unified content model

### US-001: Q&A as an interaction type
**Description:** As a developer, I need Q&A to live in the shared `interactions` model so it is managed like every other content type.

**Acceptance Criteria:**
- [ ] `interactions.type` accepts `qa`; each event can hold several Q&A interactions with their own prompt, moderation mode and state
- [ ] Existing events migrate: each event's current questions move under one auto-created Q&A interaction, with votes, status and pins preserved
- [ ] The one-live-interaction rule and `draft`/`live`/`paused`/`closed` states apply to Q&A
- [ ] When an event has several Q&A interactions, the participant sees only the live one; closed ones stay readable, and old links/QR codes to the single Q&A tab keep working
- [ ] Migration is reversible in a test and runs on a copy of existing data without loss
- [ ] Cascade delete from event still removes all Q&A data (test)
- [ ] Typecheck/lint passes
- [ ] Tests pass

### US-002: One content library per event
**Description:** As a host, I want a single list of all interactions in an event so that I manage them in one place.

**Acceptance Criteria:**
- [ ] The event page shows all interaction types in one ordered list with type icon, title, state and response count
- [ ] Host can reorder (drag with keyboard alternative), rename, duplicate, delete, start, pause and close any type from this list
- [ ] "Add content" menu lists every type available to the workspace's tier; locked types show an upgrade hint
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-003: Templates and cross-event copy
**Description:** As a host, I want to save an interaction or a whole event as a template so I can reuse it.

**Acceptance Criteria:**
- [ ] Host can save one interaction, or the full list of an event, as a workspace template (content only, no responses)
- [ ] Host can add template items to any event, or create an event from a template
- [ ] Copying a Q&A, quiz, survey or ranking item copies its config, options and images but never responses or participants
- [ ] Template count follows the tier limit (US-013)
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-004: Uniform results and export for every type
**Description:** As a host, I want the same results view and CSV export for every type so nothing is special-cased.

**Acceptance Criteria:**
- [ ] Each type exposes a results view in the presenter and a CSV export through one shared interface
- [ ] Event-level export bundles every interaction as separate CSV files in a ZIP
- [ ] CSVs contain no participant tokens or IPs; quiz nicknames appear only in leaderboard files
- [ ] Typecheck/lint passes
- [ ] Tests pass

### Part B: Remaining interaction types

### US-005: Ranking
**Description:** As a host, I want participants to rank options so I can see group priorities.

**Acceptance Criteria:**
- [ ] Host creates 2–10 options
- [ ] Participant orders options by drag-and-drop, with up/down buttons as keyboard and touch fallback
- [ ] Score per option = sum of positions weighted (1st = N points … last = 1 point)
- [ ] Presenter view shows options sorted by score with the score value; one submission per participant, enforced server-side
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-006: Quiz question model
**Description:** As a host, I want to mark correct answers so the system can score participants.

**Acceptance Criteria:**
- [ ] 2–6 options with one or more marked correct; time limit 5–120 seconds; points default 1000
- [ ] Scores are stored per participant per question
- [ ] Migration runs; config validated in `lib/interaction-config.ts`
- [ ] Typecheck/lint passes

### US-007: Run a timed quiz question
**Description:** As a participant, I want to answer within a time limit to earn points.

**Acceptance Criteria:**
- [ ] Countdown visible to participants and on the presenter view, driven by the server deadline
- [ ] Answers after the deadline are rejected by the server
- [ ] Points = full points scaled down linearly by answer time; 0 if wrong
- [ ] After close, participant sees correct/incorrect and points earned
- [ ] Answer buttons differ by colour and shape, not colour alone
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-008: Quiz leaderboard and podium
**Description:** As a participant, I want to see how I rank.

**Acceptance Criteria:**
- [ ] Quiz players enter a nickname (max 20 chars, profanity filtered) before the first question; it is a display name, not an account
- [ ] Scores add up across all quiz questions of the same event (one cumulative leaderboard per event; a host can reset it)
- [ ] A participant who joins late is ranked on the questions they answered; a participant who reconnects keeps their nickname and score (same token)
- [ ] Presenter shows top 10 after each question; participant sees own rank and score; final podium shows top 3
- [ ] Live scores kept behind a leaderboard interface with an in-memory adapter (no Redis here) and persisted to PostgreSQL when a question closes
- [ ] Animations respect `prefers-reduced-motion`
- [ ] Load test script: 500 simulated participants answer within 5 seconds and the leaderboard updates in under 1 second at p95
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-009: Survey model
**Description:** As a developer, I need surveys that group several questions.

**Acceptance Criteria:**
- [ ] A survey has an ordered list of questions of type multiple choice, rating or open text, each optionally required
- [ ] Responses are stored per question and per participant, with one submission per participant
- [ ] Cascade delete from the event (test); migration runs
- [ ] Typecheck passes

### US-010: Build and take a survey
**Description:** As a host, I want to send a multi-question survey before or after an event.

**Acceptance Criteria:**
- [ ] Host adds, reorders and deletes questions
- [ ] Survey opens at its own link with a progress indicator, also outside a live session
- [ ] Required questions block submission with a clear error message
- [ ] A second attempt shows "Already submitted"
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-011: Image storage
**Description:** As a host, I want to upload an image for a question or option.

**Acceptance Criteria:**
- [ ] PNG, JPG or WebP up to 5 MB; other types or larger files show an error
- [ ] Images are re-encoded to strip metadata, then stored behind a storage interface (local disk adapter here, S3-compatible adapter for production)
- [ ] Alt text is required before saving
- [ ] Storage use per workspace is counted for the tier limit (US-013)
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-012: Images in questions and options
**Description:** As a participant, I want to see images attached to questions and options.

**Acceptance Criteria:**
- [ ] A host can attach an image to the question or to individual options of poll, quiz and ranking
- [ ] The image appears with alt text in the participant and presenter views, and works at 360px width
- [ ] Deleting an event deletes its image files
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### Part C: Tiers, limits and billing

### US-013: Plans and entitlements model
**Description:** As a developer, I need one place that defines what each tier allows.

**Acceptance Criteria:**
- [ ] `lib/plans.ts` defines Free, Pro and Team with limits: seats (admins), events per month, participants per event, interaction types allowed, templates, image storage, AI calls per event and per month, report formats, branding, SSO/audit log
- [ ] Defaults (editable constants, see Open Questions): Free = 1 seat, 100 participants, poll/word cloud/Q&A/rating, no AI, CSV only; Pro = 3 seats, 1000 participants, all types, AI Insights, PDF/Excel; Team = 15 seats, 5000 participants, branding, audit log, 2FA enforcement
- [ ] A single `getEntitlements(workspaceId)` function is the only way code checks limits
- [ ] Features already shipped in Phase 2a are placed in tiers too: shared notes, open text and rating on Free (basic), AI note analysis on Pro and Team; existing workspaces that use AI today are moved to Pro without charge until the owner picks a plan (assumption, see Open Questions)
- [ ] Typecheck/lint passes
- [ ] Tests pass

### US-014: Enforce limits on the server
**Description:** As the platform owner, I want limits enforced by the server so they cannot be bypassed in the UI.

**Acceptance Criteria:**
- [ ] Creating a gated interaction type, exceeding the participant cap, inviting past the seat limit, using AI past the cap, or exporting a gated format returns 402/403 with a machine-readable reason
- [ ] Participant cap counts distinct joined participants per event; joining beyond it shows a clear message to the participant
- [ ] Automated tests cover one allowed and one denied request per limit
- [ ] Typecheck/lint passes
- [ ] Tests pass

### US-015: Usage and plan page
**Description:** As a workspace owner, I want to see my plan and usage.

**Acceptance Criteria:**
- [ ] Page shows current tier, seats used/total, events this month, AI calls used/cap, storage used
- [ ] Locked features elsewhere in the app show the tier that unlocks them and link here
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-016: Billing provider interface and checkout
**Description:** As a workspace owner, I want to upgrade or downgrade by paying online.

**Acceptance Criteria:**
- [ ] A `BillingProvider` interface with a Stripe implementation (checkout, customer portal, webhook) and a `mock` implementation for tests and e2e; real Stripe is never called from tests
- [ ] Subscription state (plan, status, period end) stored per workspace; webhook updates it idempotently and verifies the signature
- [ ] Monthly and yearly billing; cancel keeps access until period end
- [ ] Secrets only in `.env.local`, never logged
- [ ] Typecheck/lint passes
- [ ] Tests pass (provider mocked)

### US-017: Downgrade and grace handling
**Description:** As a workspace owner, I want a predictable result when my plan lowers or a payment fails.

**Acceptance Criteria:**
- [ ] Payment failure starts a grace period with a banner; after it, the workspace moves to Free
- [ ] On downgrade nothing is deleted: over-limit content becomes read-only and cannot be started until within limits
- [ ] Extra seats beyond the new limit are suspended, except the owner
- [ ] Tests cover downgrade with extra seats and gated content
- [ ] Typecheck/lint passes

### Part D: Workspaces, roles, branding

### US-018: Workspaces and ownership
**Description:** As a developer, I need events and billing to belong to a workspace instead of a single user.

**Acceptance Criteria:**
- [ ] `workspaces` and `memberships` (user, workspace, role) tables; every existing user gets a personal workspace and owns their events there
- [ ] All event, template and subscription queries are scoped by workspace
- [ ] Cascade delete from workspace removes all its data (test)
- [ ] Migration keeps existing data reachable
- [ ] The `users_role_admin` check on `users.role` is replaced: the account-level role is removed and the role lives only in `memberships`
- [ ] A user can belong to several workspaces and switch between them; each request carries one active workspace, checked against membership
- [ ] Typecheck/lint passes
- [ ] Tests pass

### US-019: Roles and permissions
**Description:** As a workspace owner, I want roles so teammates only do what they should.

**Acceptance Criteria:**
- [ ] Roles: owner (everything incl. billing and members), admin (everything except billing and members), editor (create/edit own and shared content, run events), moderator (moderate and run live events only), viewer (read results)
- [ ] One shared server-side authorisation function maps role → permission; routes never check roles inline
- [ ] The MVP moderator-link is removed (`app/moderate` link flow); the moderator role replaces it
- [ ] Audience (no login) can still only join, answer, ask, upvote, and view results the host shows
- [ ] Tests cover one allowed and one denied request per role and per audience capability
- [ ] Typecheck/lint passes
- [ ] Tests pass

### US-020: Invite and manage members
**Description:** As an owner or admin, I want to invite teammates and manage them.

**Acceptance Criteria:**
- [ ] Invite by email with a role; the invite link is shown once and also emailed when an email adapter is configured (log adapter in dev)
- [ ] Accepting creates or links the account; a new user must set a password
- [ ] Owner/admin can change role, suspend, reactivate or remove a member; suspended members' sessions end
- [ ] The last owner cannot be removed or demoted; inviting past the seat limit returns the US-014 error
- [ ] Admin can reset a member's password (temporary password shown once, `must_change_password` set)
- [ ] Add `must_change_password` and `last_login_at` to `users`
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-021: Workspace branding
**Description:** As a Team-tier workspace, I want my logo and colours on the participant and presenter screens.

**Acceptance Criteria:**
- [ ] Owner uploads a logo (same image rules as US-011) and picks one accent colour
- [ ] The accent is checked against contrast rules; a colour that fails AA is rejected with a message
- [ ] Participant and presenter screens use the logo and accent, in light and dark mode
- [ ] Gated to the tier that allows branding
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### Part E: AI Insights

### US-022: Event data snapshot for AI
**Description:** As a developer, I need a safe, uniform way to prepare event data for AI.

**Acceptance Criteria:**
- [ ] A function builds a snapshot per interaction type: poll/rating/ranking/quiz as aggregates; Q&A, notes, open text and survey free text as approved items with an item ID and text only
- [ ] Nicknames, participant tokens, IPs and emails are never included; hidden and rejected items are excluded
- [ ] Snapshot is deterministic and hashed, so unchanged data reuses the cached result
- [ ] Large inputs are capped and batched per the existing note rules
- [ ] Typecheck/lint passes
- [ ] Tests pass

### US-023: Generate AI Insights for an event
**Description:** As a host, I want an AI report that explains what happened in my event so I can present and act on it.

**Acceptance Criteria:**
- [ ] Runs only when a host clicks "Generate insights"; never automatically; button disabled while running; counts against the tier's AI cap
- [ ] Output (schema-validated JSON): headline takeaway, executive summary (max 150 words), 3–6 themes with supporting item IDs, sentiment split with the share of positive/neutral/negative, "what surprised us" (up to 3 findings, e.g. a poll result that contrasts with the free-text comments), top concerns raised in Q&A, and 3–5 suggested follow-up actions
- [ ] Every claim cites item IDs or aggregates that exist in the snapshot; claims with no valid reference are dropped before storing
- [ ] Output follows the language of the audience's text, or the host's UI language when mixed
- [ ] Runs in the background job system with progress; the live event never waits on it
- [ ] Failure shows a reason; a non-AI summary (counts, top items, word frequency) is still shown
- [ ] Stored with model, prompt version and run time; marked outdated when new data arrives
- [ ] Mock provider used in tests; never a real API
- [ ] Typecheck/lint passes
- [ ] Tests pass

### US-024: Insights presentation
**Description:** As a host, I want the insights to look impressive on the big screen.

**Acceptance Criteria:**
- [ ] Presenter shows insights as a stepped story: headline → themes → sentiment → surprises → concerns → next steps, advanced by key or button
- [ ] Each theme can be opened to show its source items; each insight shows its "AI-generated" label and outdated state
- [ ] Charts have labels and values, respect `prefers-reduced-motion`, and follow `DESIGN.md` tokens
- [ ] Participants see insights only after the host publishes them
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-025: Edit, publish and share insights
**Description:** As a host, I want to correct the AI output before sharing it.

**Acceptance Criteria:**
- [ ] Host can edit headline, summary, theme names and actions, delete a finding, and remove items from a theme; edits survive display; re-run asks before replacing edits
- [ ] Host can publish a read-only share link to the insights page (no participant data), and revoke it
- [ ] Insights are included in the PDF and Excel reports
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-026: AI usage controls and privacy notice
**Description:** As an owner, I want control over AI use and clear privacy handling.

**Acceptance Criteria:**
- [ ] A settings page shows the active provider and model (never the key) with a "Test connection" button; it is visible to the platform operator (US-035) and hidden from workspace members
- [ ] Owner can disable AI for the whole workspace; AI UI is then hidden
- [ ] Host sees a notice before the first analysis in a workspace; participants see a one-line disclosure on screens whose text may be analysed
- [ ] Per-event and per-month caps from the tier are shown with remaining calls; exceeding returns the US-014 error
- [ ] Keys and item text are never logged
- [ ] Typecheck/lint passes
- [ ] Tests pass

### Part F: Reports

### US-027: Event analytics summary
**Description:** As a host, I want an event summary of how engaged the audience was.

**Acceptance Criteria:**
- [ ] Unique participants, peak concurrent participants, total responses, response rate per interaction, top 5 questions by upvotes
- [ ] Loads in under 2 seconds for an event with 5,000 responses
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-028: PDF and Excel reports
**Description:** As a host, I want to download reports to share results.

**Acceptance Criteria:**
- [ ] "Download PDF" has the summary, a chart per interaction and the AI insights if present; "Download Excel" has one sheet per interaction type
- [ ] Both use one background job mechanism with progress and a download link; generation takes under 5 seconds for 5,000 responses
- [ ] No identifying data for anonymous participants; quiz nicknames only in the leaderboard
- [ ] Gated to the tier that allows them
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### Part G: Security and privacy

### US-029: Two-factor login
**Description:** As a member, I want 2FA to protect my account.

**Acceptance Criteria:**
- [ ] Member can enable TOTP with a QR code and 10 one-time recovery codes shown once
- [ ] Login asks for the code after the password; recovery codes work once each
- [ ] Owner can require 2FA for the workspace (Team tier); members without it must set it up at next login
- [ ] Secrets are encrypted at rest; verification attempts are rate limited
- [ ] Typecheck/lint passes
- [ ] Tests pass
- [ ] **Verify in browser using dev-browser skill**

### US-030: Audit log
**Description:** As an owner, I want a record of sensitive actions.

**Acceptance Criteria:**
- [ ] Logs: login, failed login, role change, member add/remove, plan change, event delete, export, AI run, AI settings change
- [ ] Entries hold actor, action, target, time and IP, never note text or keys; viewable and filterable by owner/admin
- [ ] Gated to Team tier; entries are append-only
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-031: Data retention and deletion
**Description:** As an owner, I want to control how long data is kept.

**Acceptance Criteria:**
- [ ] Owner sets a retention period (30, 90, 365 days, or keep) per workspace; a daily job deletes expired events, responses and images
- [ ] Owner can delete an event immediately and permanently; deletion cascades to all data and files
- [ ] A host can export an event before deletion; the app warns 7 days before an automatic delete
- [ ] Deleted-data tests cover every table that holds event data
- [ ] Typecheck/lint passes
- [ ] Tests pass

### Part H: Localisation

### US-032: Translation infrastructure
**Description:** As a developer, I need all UI text in translation files.

**Acceptance Criteria:**
- [ ] All user-facing strings (including `lib/copy.ts` and API error messages) come from `id` and `en` message files via one helper; no strings left inline
- [ ] A test fails when a key exists in one language and not the other
- [ ] Dates, numbers and plural forms use `Intl`
- [ ] Typecheck/lint passes
- [ ] Tests pass

### US-033: Indonesian UI and language selection
**Description:** As a user, I want to use the app in Indonesian or English.

**Acceptance Criteria:**
- [ ] Host chooses a UI language in settings; each event has an audience language, set at creation, used on the join, participant and presenter screens
- [ ] Participant can switch language on the join screen
- [ ] Indonesian copy is reviewed to read as native, not translated word for word (follow `docs/antislop` copy rules)
- [ ] Layout holds with the longer Indonesian strings at 360px
- [ ] Word-cloud stopword lists exist for both languages
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### Part I: Onboarding, platform operations and compliance

### US-034: Sign-up, email verification and password reset
**Description:** As a new customer, I want to create an account and workspace by myself, and recover my password.

**Acceptance Criteria:**
- [ ] Sign-up (email and password) creates a user, a workspace on the Free tier, and an owner membership; sign-up is rate limited
- [ ] The email must be verified by a link before the workspace can start an event or invite members; unverified users see a banner with "Resend"
- [ ] "Forgot password" sends a single-use link that expires in 60 minutes; the response never reveals whether the email exists
- [ ] Password change ends the user's other sessions
- [ ] Email goes through the email interface (log adapter in dev and tests, real adapter by env)
- [ ] Typecheck/lint passes
- [ ] Tests pass
- [ ] **Verify in browser using dev-browser skill**

### US-035: Platform operator console
**Description:** As the platform owner, I want an internal console so that I can support customers and watch costs.

**Acceptance Criteria:**
- [ ] A platform-operator flag on a user (set only by env allow-list or a CLI script, never in the UI) opens `/ops`; everyone else gets 404
- [ ] Lists workspaces with plan, status, seats, events this month, AI calls and estimated AI cost
- [ ] Operator can suspend or reactivate a workspace, override its plan for a period (with a reason), and reset a member's 2FA
- [ ] Shows active AI provider/model with "Test connection", and the current global daily AI cap and spend
- [ ] Every operator action is written to the audit log (US-030) with the operator as actor
- [ ] Typecheck/lint passes
- [ ] Tests pass
- [ ] **Verify in browser using dev-browser skill**

### US-036: Pricing page and legal pages
**Description:** As a visitor, I want to see plans and the legal terms before I sign up.

**Acceptance Criteria:**
- [ ] A public `/pricing` page lists tiers and limits read from `lib/plans.ts` (one source), with monthly/yearly toggle and a sign-up link
- [ ] `/terms` and `/privacy` pages exist, linked from the footer, sign-up and join screens; the text is supplied by the project owner (placeholder clearly marked until then)
- [ ] The privacy page states that AI-processed text goes to a third party, and what is stored
- [ ] Pages are in both languages (US-033), follow `DESIGN.md`, and work at 360px
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-037: Account and data rights
**Description:** As a customer, I want to take my data out and delete it.

**Acceptance Criteria:**
- [ ] Owner can export the whole workspace (events, responses, templates, insights) as a ZIP through the background job system
- [ ] A member can delete their account; owners must first transfer ownership or delete the workspace
- [ ] Deleting a workspace asks for a typed confirmation, cancels the subscription through the billing provider, removes all data and files (cascade tests), and keeps only an audit entry without content
- [ ] Participants can be removed on request by a host: "Delete participant data" removes one participant's responses, notes, questions and votes in an event
- [ ] Typecheck/lint passes
- [ ] Tests pass

### US-038: Operational safeguards
**Description:** As the platform owner, I want guards against abuse and runaway cost.

**Acceptance Criteria:**
- [ ] Rate limits exist per IP (audience) and per workspace (hosts, exports, AI, uploads) behind the existing rate-limit interface
- [ ] A global daily AI spend cap stops all AI calls when reached and shows the operator an alert; hosts see "AI is paused for today"
- [ ] Health endpoint reports migrations, database, job runner and storage; failing jobs are retried with backoff and recorded
- [ ] Uploaded files are checked for type by content, not by extension
- [ ] Typecheck/lint passes
- [ ] Tests pass

### Part J: Quality

### US-039: Extend end-to-end tests and docs
**Description:** As a developer, I want the new flows covered.

**Acceptance Criteria:**
- [ ] E2E covers: sign-up and verify, invite and role limits, upgrade through the mock billing provider, a gated feature locking after downgrade, quiz with cumulative leaderboard, survey submit, Indonesian join flow, and AI Insights on the mock provider
- [ ] README and the deploy doc describe new env vars (billing, storage, email, 2FA encryption key, operator allow-list)
- [ ] `npm run lint`, `typecheck`, `test`, `test:e2e` pass
- [ ] Typecheck/lint passes

### US-040: Final audit pass
**Description:** As the owner, I want the new screens to meet the design and accessibility bar.

**Acceptance Criteria:**
- [ ] New screens follow `DESIGN.md` tokens and the antislop rules, in light and dark
- [ ] axe run (contrast on) over new pages in both languages shows no serious violations
- [ ] All new screens work at 360px and by keyboard
- [ ] All HIGH and MEDIUM antislop findings fixed
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

## 4. Functional Requirements

- FR-1: The system must support these interaction types in one library: poll, word cloud, Q&A, shared notes, open text, rating, ranking, quiz and survey, all with the same lifecycle, ordering, duplication, templating and export.
- FR-2: Images (PNG/JPG/WebP, ≤ 5 MB, required alt text) must be supported in questions and options of poll, quiz and ranking.
- FR-3: Quiz answers after the server deadline must be rejected; the system must show a top-10 leaderboard and a final podium.
- FR-4: Surveys must support required questions and one submission per participant.
- FR-5: All data belongs to a workspace; every query is scoped by it.
- FR-6: The system must provide five roles (owner, admin, editor, moderator, viewer) and the anonymous audience; authorisation is decided in one shared server-side function.
- FR-7: Tiers (Free, Pro, Team) must define seats, participants per event, events per month, allowed types, templates, storage, AI caps, report formats, branding and audit log. The server must enforce every limit.
- FR-8: Billing must go through a provider interface; subscription state is updated only by verified webhooks.
- FR-9: Downgrades must never delete data; over-limit content becomes read-only.
- FR-10: AI Insights must run only on a host's click, use only approved text without identifiers, validate output against a schema, drop claims without valid source references, be labelled AI-generated, and be editable and publishable by the host.
- FR-11: If AI is unavailable or off, a non-AI summary must still be shown.
- FR-12: The system must support TOTP 2FA, an audit log (Team tier) and per-workspace retention with permanent deletion.
- FR-13: The UI must be available in Indonesian and English, with an audience language per event.
- FR-14: Reports (CSV, PDF, Excel) must contain no identifying data for anonymous participants.
- FR-15: All new participant-facing screens must meet WCAG 2.1 AA and work at 360px.
- FR-16: Customers must be able to sign up on their own, verify their email, and reset their password by email.
- FR-17: A platform operator (outside the workspace role model) must be able to suspend workspaces, override plans, and watch AI usage and cost; every such action is audited.
- FR-18: Owners must be able to export all workspace data and delete the workspace; hosts must be able to delete one participant's data from an event.
- FR-19: A public pricing page and terms/privacy pages must exist, and pricing must be read from the same source as enforcement.
- FR-20: Quiz scores must accumulate across the questions of an event.
- FR-21: A global daily AI spend cap must stop AI calls regardless of workspace limits.

## 5. Non-Goals (Out of Scope)

- No public API, webhooks for customers, PowerPoint/Google Slides add-ins, or Zoom/Teams/Webex apps (candidate for Phase 4)
- No SSO/SAML or SCIM (candidate for Phase 4, enterprise tier)
- No native iOS or Android apps
- No audience accounts, sign-up or social login
- No languages beyond Indonesian and English
- No video, audio or screen sharing
- No AI features outside AI Insights and the existing note analysis (no auto-generated polls, no live AI during voting)
- No cross-event long-term trend analytics
- No invoicing, tax handling, coupons or enterprise contracts (card checkout and customer portal only)
- No copying of Slido's branding, copy or design assets

## 6. Design Considerations

- Follow `DESIGN.md` (Warm editorial, light and dark) and the antislop rules in `docs/antislop/`; use tokens, no hardcoded colours.
- Reuse the presenter layout, bar-chart component, participant tab navigation and the shared UI primitives.
- Locked features stay visible with the tier name, not hidden, except AI when the workspace has disabled it.
- Quiz: large answer buttons with distinct colour and shape. Leaderboard animations respect `prefers-reduced-motion`.
- Drag-and-drop ranking and list reordering need keyboard alternatives.
- Insights story view must stay readable from the back of a room: large type, high contrast.

## 7. Technical Considerations

**Permission matrix** (the single source for US-019; `Y` = allowed, `own` = only content they created):

| Action | Owner | Admin | Editor | Moderator | Viewer |
|---|---|---|---|---|---|
| Billing, plan, delete workspace | Y | | | | |
| Members and roles, 2FA policy, retention | Y | Y | | | |
| Branding, workspace templates | Y | Y | | | |
| Create/edit events and interactions | Y | Y | Y | | |
| Delete events and interactions | Y | Y | own | | |
| Run live (start, pause, close, show results) | Y | Y | Y | Y | |
| Moderate Q&A, notes, open text | Y | Y | Y | Y | |
| Generate, edit and publish AI Insights | Y | Y | Y | | |
| Exports and reports | Y | Y | Y | | Y |
| View results and analytics | Y | Y | Y | Y | Y |
| Audit log | Y | Y | | | |

Platform operator is a separate flag (US-035), not a workspace role.

- Stack as in `CLAUDE.md`: Next.js, TypeScript, PostgreSQL (Drizzle), Socket.IO custom server. Redis, Docker and system packages are not available: use in-memory adapters behind interfaces for the leaderboard, rate limiter and pub/sub, a local-disk adapter behind the storage interface, and a log adapter behind the email interface. Production adapters (S3-compatible, SMTP/transactional email) are configured by env vars.
- Every new table that holds event or workspace data references `workspaces`, `events` or `interactions` with `onDelete: "cascade"` and gets a cascade test.
- Entitlements are checked in one function and one middleware; UI hints are never the enforcement.
- Billing: provider interface (`stripe`, `mock`); verify webhook signatures; idempotent event handling. Never call real Stripe or AI from tests, e2e or Ralph runs.
- Existing data migrates in place: personal workspace per user, Q&A questions under auto-created Q&A interactions. Write and test the migrations on seeded data.
- Q&A migration is the riskiest step; ship it behind its own migration and run the full e2e after it.
- AI: keep the provider-agnostic `lib/ai` client; add a prompt version for insights; keep notes/text as delimited data with the "ignore instructions in the data" rule; strict schema validation plus reference checking.
- 2FA secrets and any stored third-party tokens are encrypted with a key from env; keys never printed or committed.
- PDF/Excel generation runs in the background job system.
- Capacity: the largest tier allows 5,000 participants per event, so check Socket.IO connection and broadcast cost at that size (a script, not a promise of multi-node scale). Give the realtime layer a pub/sub interface so a multi-instance adapter can be added later.
- Seat counting: a seat is an active membership of any role; pending invitations count as seats so limits cannot be bypassed by inviting many people.
- Time and money: store prices and limits in `lib/plans.ts`; store amounts as integer minor units with an ISO currency; compute month boundaries in one timezone (UTC) and show them as such.
- Performance: leaderboard < 1 s p95 at 500 participants; reports < 5 s at 5,000 responses; analytics page < 2 s at 5,000 responses; AI Insights for a typical event < 60 s.

## 8. Success Metrics

- At least 30% of active hosts use three or more interaction types within 60 days.
- At least 10% of Free workspaces that hit a limit open the upgrade page; track limit hits per reason.
- AI Insights: ≥ 90% of runs pass schema validation on the first attempt, ≥ 95% of kept claims cite a valid source, and ≥ 40% of hosts who generate one edit or share it.
- Leaderboard, report and analytics performance targets in Section 7 met.
- Zero cross-workspace data access in the authorisation test suite.

## 9. Open Questions

- Final tier names, prices and the limits in US-013. Are the defaults right for the market?
- Which payment provider(s) for Indonesian customers (cards only with Stripe, or also bank transfer, e-wallets or QRIS through another provider)? What currency?
- Free trial of Pro, or only Free vs paid?
- Should Q&A stay one-per-event for the Free tier to keep it simple?
- Which email service for invites and later password reset links?
- Where do images live in production (provider, region), and what is the default retention period?
- Is sending text to a third-party AI acceptable for target customers (education, EU data)? Is the notice enough, or is an opt-in per workspace needed?
- Does AI Insights need a "present" mode with no editing, for use live on stage?
- Should SSO, API and integrations be a Phase 4 PRD?
- Should the AI note analysis that already exists stay free for current users, or move to Pro as US-013 assumes?
- Who writes the terms and privacy text, and in which jurisdiction does the company operate (affects data-protection duties and tax)?
- Is a seat counted for moderators and viewers, or only for people who can edit?
- Do we need a status page or support channel for customers before launch?

## 10. Milestones (8 phases, build in this order)

Each milestone is one Ralph run: its own `prd.json` and branch (`ralph/phase3-m1` …), merged to `main` only when its exit gate passes. Every gate includes `lint`, `typecheck`, `test` and `test:e2e` green. Story counts add up to all 40 stories.

| # | Milestone | Stories | Count |
|---|---|---|---|
| M1 | Foundation: translation base, workspaces, roles, sign-up, members | US-032, US-018, US-019, US-034, US-020 | 5 |
| M2 | Plans and billing (test mode) | US-013, US-014, US-015, US-016, US-017 | 5 |
| M3 | Unified content (Q&A migration, library, templates) | US-001, US-002, US-003, US-004 | 4 |
| M4 | New interaction types: ranking, quiz, survey | US-005, US-006, US-007, US-008, US-009, US-010 | 6 |
| M5 | Images and reports | US-011, US-012, US-027, US-028 | 4 |
| M6 | AI Insights | US-022, US-023, US-024, US-025, US-026 | 5 |
| M7 | Security, operations and branding | US-029, US-030, US-031, US-037, US-038, US-035, US-021 | 7 |
| M8 | Indonesian UI, pricing page, tests and final audit | US-033, US-036, US-039, US-040 | 4 |

### M1: Foundation
- **Goal:** several people can work in one workspace with the right permissions, and no new string is written inline.
- **Order inside:** US-032 first (touches every existing string), then US-018 (workspace migration), US-019, US-034, US-020.
- **Exit gate:** existing users and events survive the migration on seeded data; the permission matrix is covered by tests; the MVP moderator link is gone; en and id key parity test passes.
- **Risk:** the workspace migration and the string extraction touch most files. Keep each as its own commit.

### M2: Plans and billing (test mode)
- **Goal:** limits are enforced on the server and a workspace can upgrade and downgrade, using the mock provider.
- **Exit gate:** one allowed and one denied test per limit; downgrade makes over-limit content read-only without deleting; real Stripe is not called anywhere. Stripe test-mode keys and webhooks are wired at the end of this milestone by the project owner.
- **Depends on:** M1 (workspace and seats).

### M3: Unified content
- **Goal:** Q&A, polls and the rest are managed from one list; templates and bulk export work.
- **Exit gate:** the Q&A migration runs on a copy of real data without loss; old Q&A links still work; cascade tests pass; full e2e green.
- **Risk:** highest of all milestones. Do US-001 first and stop to run the whole e2e before US-002.
- **Depends on:** M2 (template count limit).

### M4: Ranking, quiz, survey
- **Goal:** the three missing interaction types work in the shared lifecycle.
- **Exit gate:** quiz load script with 500 simulated participants shows the leaderboard under 1 second at p95; ranking has a keyboard path; the survey enforces required questions and one submission.
- **Depends on:** M3 (the library and the uniform results interface).

### M5: Images and reports
- **Goal:** images in questions and options; summary, PDF and Excel reports.
- **Exit gate:** images are re-encoded and deleted with their event; storage counts against the tier; the analytics page loads in under 2 seconds and reports build in under 5 seconds for 5,000 responses; no identifiers in any file.
- **Depends on:** M4 (all types need report sheets).

### M6: AI Insights
- **Goal:** one AI report over the whole event, shown as a story on the big screen.
- **Exit gate:** tested only with the mock provider; claims without valid references are dropped (test); insights are included in PDF and Excel; caps follow the tier. The "Test connection" button for operators arrives in US-035 (M7), so a manual connection check is done by the project owner until then.
- **Depends on:** M5 (reports and the data snapshot of every type).

### M7: Security, operations and branding
- **Goal:** the platform is safe to sell: 2FA, audit log, retention, data rights, rate limits, operator console, branding.
- **Order inside:** US-030 (audit log) before US-035 (operator console writes to it).
- **Exit gate:** deleting a workspace removes all data and files (cascade tests for every table); retention job tested; operator routes return 404 to others.
- **Public launch gate:** do not open public sign-up before M7 passes and the terms and privacy text exist.

### M8: Indonesian UI, pricing page, final checks
- **Goal:** the product reads natively in Indonesian and English, and is ready to show to customers.
- **Exit gate:** axe run clean in both languages and both themes; layouts hold at 360px; e2e covers the Indonesian join flow; all HIGH and MEDIUM antislop findings fixed; deploy doc lists every env var.

### Dependencies at a glance
M1 → M2 → M3 → M4 → M5 → M6 → M7 → M8. There is no parallel track on purpose: M3 changes core tables and everything after it builds on those. If a milestone must be cut for time, cut from the end of the list (M8's pricing page waits until M7), never from the middle.
