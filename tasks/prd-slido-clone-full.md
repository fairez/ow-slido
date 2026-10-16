# PRD: Slido Clone — Extended Interactions, Reports & Admin Users (Phase 2)

> **Depends on:** `prd-slido-clone.md` (MVP). That PRD's features must already exist: host auth (`users` table with `role` = `admin`), events with join codes, participant join (`participants` table), the shared `interactions` base model with polls and word cloud, Q&A with moderation, the presenter view, CSV export, and presence/engagement metrics. This PRD adds the items listed under *Focused scope*; billing, integrations and teams are left for a later phase. Story IDs restart at US-001 so this file can be converted on its own.
>
> **Focused scope:** this PRD covers only (1) the new interaction types (including Shared Notes, which also covers the former ideas board, with AI analysis), (2) images in questions and options, (3) the analytics summary with PDF/Excel reports, and (4) basic user management (admin and no-login audience). English only. Billing and plans, integrations (public API, slide add-ins, meeting apps), and teams/branding (workspaces, multiple roles, templates, themes) and localisation are intentionally excluded. The MVP's separate moderator-invite link is retired by this PRD (US-003); admins moderate.
>
> **Assumptions (change if wrong):** commercial product · original name and branding, with no Slido assets or copy · single-host accounts as in the MVP · stack as chosen in the MVP.

## 1. Introduction/Overview

The MVP lets a host run polls, word clouds and Q&A. Phase 2 turns it into a full audience-engagement platform. It adds more interaction types (quiz, rating, open text, ranking, survey, shared notes), image support, an analytics summary with PDF/Excel reports, and basic user management with two kinds of users: admins (log in, can do everything) and audience (no login). This lets hosts run richer, more engaging sessions and share results afterwards.

## 2. Goals

- Offer at least 6 interaction types beyond the MVP's poll and word cloud.
- A host can turn 200 shared notes into an AI summary, categories and a word cloud in under 30 seconds, and the live note stream never waits on the AI provider.
- A host can run a quiz with a live leaderboard for 500 participants without lag (p95 < 1s).
- Hosts see a post-event report within 5 seconds of ending an event.
- Only two kinds of users: admins (log in, full access) and audience (no login, participation only, identified by an anonymous token that may carry a self-chosen nickname), enforced on the server.

## 3. User Stories

### US-001: Admin account management fields
**Description:** As a developer, I need extra account fields so that admins can be created with temporary passwords and deactivated.

**Acceptance Criteria:**
- [ ] `users` table (from the MVP) gains `must_change_password` (default false) and `last_login_at`
- [ ] Existing MVP host accounts keep role `admin` and `active = true`
- [ ] Audience members have no `users` row; they are identified only by the `participants` token record
- [ ] Migration runs successfully
- [ ] Typecheck/lint passes

### US-002: Admin manages admin accounts
**Description:** As an admin, I want to add, deactivate and reset passwords for other admins so that I control who can run the platform.

**Acceptance Criteria:**
- [ ] "Users" page (admin only) lists all admins with email, status and created date
- [ ] Admin can create an admin account (email and temporary password; the new admin must change the password at first login)
- [ ] Admin can deactivate and reactivate an account; a deactivated admin cannot log in and existing sessions end
- [ ] Admin can reset another admin's password: the system generates a temporary password, shows it once to the resetting admin, and sets `must_change_password`; no email is sent
- [ ] An admin cannot deactivate their own account, and the last active admin cannot be deactivated
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-003: Enforce admin vs audience access
**Description:** As an admin, I want everything that manages the platform to require login so that audience members cannot change anything.

**Acceptance Criteria:**
- [ ] All host actions (create/edit/delete events and interactions, start/close, moderation, analytics, exports, user management) require an active admin session; the server returns 401 without a session
- [ ] Admin can do all actions; there is no other logged-in role
- [ ] Audience (no login) can only: join an event, view the live interaction, submit answers/questions/notes, upvote, and view results the admin chose to show
- [ ] Audience requests to admin routes or endpoints are rejected (401) and `/dashboard`, `/present` and other admin pages redirect to `/login`
- [ ] MVP moderator links stop working after this release; the moderation queue is available to admins only
- [ ] Automated tests cover one allowed and one denied request per audience capability
- [ ] Typecheck/lint passes
- [ ] Tests pass

### US-004: Register the new interaction types
**Description:** As a developer, I need the shared interaction model to accept the new types so that they reuse state, ordering and result handling.

**Acceptance Criteria:**
- [ ] `interactions.type` (from MVP US-004) accepts `openText`, `rating`, `ranking`, `quiz`, `survey` and `sharedNotes` in addition to `poll` and `wordcloud`
- [ ] Each new type has a validated `config` schema; invalid config is rejected by the server
- [ ] The one-live-interaction-per-event rule and the `draft`/`live`/`closed` states apply to every type
- [ ] No data migration is needed for existing polls and word clouds
- [ ] Typecheck/lint passes
- [ ] Tests pass
- [ ] Typecheck/lint passes

### US-005: Open text interaction
**Description:** As a host, I want to ask an open-ended question so that I can collect free-text answers.

**Acceptance Criteria:**
- [ ] Host creates an open text prompt (max 200 chars) with a response limit per participant (1–3)
- [ ] Participants submit answers (max 300 chars)
- [ ] Presenter view lists responses live, newest first
- [ ] Host can highlight, hide or delete a response
- [ ] Profanity filter applies to responses
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-006: Rating interaction
**Description:** As a host, I want to collect ratings so that I can measure satisfaction.

**Acceptance Criteria:**
- [ ] Host chooses scale: stars (1–5) or numeric (1–10)
- [ ] Participant submits one rating per rating interaction (enforced server-side)
- [ ] Presenter view shows average, total responses and a distribution chart
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-007: Ranking interaction
**Description:** As a host, I want participants to rank options so that I can see group priorities.

**Acceptance Criteria:**
- [ ] Host creates 2–10 options
- [ ] Participant orders options by drag-and-drop, with up/down buttons as a keyboard and touch fallback
- [ ] Score per option = weighted sum of positions (1st = N points … last = 1 point)
- [ ] Presenter view shows options sorted by score with the score value
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-008: Quiz question model with correct answers
**Description:** As a host, I want to mark correct answers so that the system can score participants.

**Acceptance Criteria:**
- [ ] Quiz question supports 2–6 options with one or more marked correct
- [ ] Per-question time limit (5–120 seconds) and points value (default 1000)
- [ ] Scores stored per participant per question
- [ ] Migration runs successfully
- [ ] Typecheck passes

### US-009: Run a quiz question with timer
**Description:** As a participant, I want to answer within a time limit so that I can earn points.

**Acceptance Criteria:**
- [ ] Countdown timer is visible to participants and on the presenter view
- [ ] Answers submitted after time expires are rejected by the server
- [ ] Points = full points scaled down linearly by answer time; 0 if wrong
- [ ] After the question closes, participant sees correct/incorrect and points earned
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-010: Quiz leaderboard
**Description:** As a participant, I want to see the leaderboard so that I know how I rank.

**Acceptance Criteria:**
- [ ] Participants who play a quiz must enter a nickname (max 20 chars, stored in `participants.nickname`) before the first question; it is a display name, not an account
- [ ] Presenter view shows the top 10 with nickname and score after each question
- [ ] Participant sees their own rank and score
- [ ] Final podium screen shows the top 3
- [ ] Offensive nicknames are blocked by the profanity filter
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-011: Survey data model
**Description:** As a developer, I need to group several questions into a survey so that participants answer them as one form.

**Acceptance Criteria:**
- [ ] A survey has an ordered list of questions of types: multiple choice, rating, open text
- [ ] Each question can be marked required
- [ ] Migration runs successfully
- [ ] Typecheck passes

### US-012: Build and take a survey
**Description:** As a host, I want to send a multi-question survey before or after an event so that I can gather feedback.

**Acceptance Criteria:**
- [ ] Host builds a survey by adding, reordering and deleting questions
- [ ] Survey opens at its own link, with a progress indicator
- [ ] Required questions block submission with a clear error message
- [ ] Each participant can submit once; a second attempt shows "Already submitted"
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-013: Image upload and storage
**Description:** As a host, I want to upload an image so that I can use it in a question or option.

**Acceptance Criteria:**
- [ ] Upload PNG, JPG or WebP up to 5 MB; larger files or other types show an error
- [ ] Images are re-encoded to strip metadata and stored in S3-compatible storage behind a CDN
- [ ] Alt text field is required before the image can be saved
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-014: Show images in questions and options
**Description:** As a participant, I want to see images attached to questions and options so that I can answer visual questions.

**Acceptance Criteria:**
- [ ] A host can attach an image to a question or to individual options of poll, quiz and ranking interactions
- [ ] The image appears with its alt text on the participant view and the presenter view
- [ ] Layout works at 360px width
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-015: Event analytics summary
**Description:** As a host, I want an event summary so that I can see how engaged the audience was.

**Acceptance Criteria:**
- [ ] Summary shows: unique participants, peak concurrent participants (from the MVP's presence data), total responses, response rate per interaction
- [ ] Top 5 questions by upvotes are listed
- [ ] Page loads in under 2 seconds for an event with 5,000 responses
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-016: Export report as PDF
**Description:** As a host, I want to download a PDF report so that I can share results with stakeholders.

**Acceptance Criteria:**
- [ ] "Download PDF" produces a report with the summary and a chart for each interaction
- [ ] The PDF is generated in a background job; the host sees progress and a download link when it is ready
- [ ] Anonymous participants have no identifying data in the file; quiz nicknames appear only in the leaderboard section
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-017: Export report as Excel
**Description:** As a host, I want to download an Excel file so that I can analyse results further.

**Acceptance Criteria:**
- [ ] "Download Excel" produces an .xlsx with one sheet per interaction type
- [ ] Generated through the same background job mechanism as the PDF
- [ ] Anonymous participants have no identifying data in the file; quiz nicknames appear only in the leaderboard sheet
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-018: Write and upvote shared notes
**Description:** As a participant, I want to write notes about the event and upvote other people's notes so that the most useful takeaways surface.

**Acceptance Criteria:**
- [ ] Host creates a Shared Notes interaction (type `sharedNotes`) with a prompt, e.g. "What are your key takeaways?"
- [ ] Participants submit notes (max 500 chars), up to a host-set limit of 1–10 per participant, and can edit or delete their own note while the interaction is `live`
- [ ] Notes can be anonymous or show the participant's optional nickname
- [ ] Each participant can upvote each other participant's note once (tapping again removes it) and cannot upvote their own note; enforced on the server
- [ ] Host can set Open or Moderated mode, reusing the Q&A moderation queue (approve, reject, pin, delete)
- [ ] Profanity filter applies to notes
- [ ] Notes list is sortable by Popular and Recent, and updates live
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-019: AI provider integration
**Description:** As an admin, I want to connect an AI provider so that notes can be summarized and categorized.

**Acceptance Criteria:**
- [ ] A server-side AI client supports OpenAI and OpenRouter through a single interface; the provider, model and API key are one platform-owned key set by environment variables, shared by all admins, and never sent to the browser
- [ ] Admin settings page shows which provider and model are active and has a "Test connection" button
- [ ] Requests have a timeout, retry with backoff on 429/5xx, and a per-event and per-day call cap
- [ ] Model output is requested as JSON and validated against a schema; invalid output counts as a failure
- [ ] If no API key is configured, AI features are hidden and Shared Notes still works
- [ ] API keys and note text are never written to logs
- [ ] Typecheck/lint passes
- [ ] Tests pass (provider mocked)

### US-020: Analyze notes with AI
**Description:** As a host, I want to analyze the notes so that I get a summary, categories and keywords without reading everything.

**Acceptance Criteria:**
- [ ] Analysis runs only when a host clicks "Analyze notes" (during or after the interaction); it never starts automatically on new notes, on close or on a timer
- [ ] It runs as a background job and shows progress; while it runs the button is disabled to prevent duplicate runs
- [ ] Only approved notes are sent, with a note ID and text only; nicknames, participant tokens and IP addresses are never sent
- [ ] Notes are passed to the model as data, with instructions to ignore any instructions inside them
- [ ] Result is stored as an analysis record: a summary (max 150 words), 3–8 categories each with a name, a one-line description and the IDs of its notes, and up to 50 keywords with weights
- [ ] Every note is assigned to exactly one category, or to "Uncategorized"
- [ ] Notes added after an analysis mark the result as outdated; the host can re-run it
- [ ] More than 500 notes are processed in batches and merged; the result records the model used and the run time
- [ ] If the AI call fails, the host sees an error and a frequency-based word cloud is shown as a fallback
- [ ] Typecheck/lint passes
- [ ] Tests pass (provider mocked)

### US-021: Show analysis as word cloud and charts
**Description:** As a host, I want to show the analyzed notes on the presenter screen so that the audience sees the themes.

**Acceptance Criteria:**
- [ ] Presenter view for Shared Notes has switchable views: word cloud (keyword weights), category bar chart (note count and % per category), top upvoted notes, and the AI summary
- [ ] Clicking a category lists its notes, ordered by upvotes
- [ ] Charts show labels and values, not colour alone, and respect `prefers-reduced-motion`
- [ ] Participants see the analysis only after the host publishes it
- [ ] Views show an "AI-generated" label and the "outdated" state when it applies
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-022: Review and edit AI results; include in reports
**Description:** As a host, I want to correct the AI output before sharing it so that mistakes do not reach the audience.

**Acceptance Criteria:**
- [ ] Host can rename, merge and delete categories, move a note to another category, edit the summary and remove keywords
- [ ] Edits are kept when the analysis is displayed; re-running asks for confirmation before replacing edits
- [ ] The analytics summary, PDF and Excel reports include the summary, categories with counts, the word cloud and the top upvoted notes
- [ ] Reports contain no nicknames or other identifying data
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

## 4. Functional Requirements

- FR-1: The system must support these interaction types: poll, word cloud, open text, rating, ranking, quiz, survey and shared notes.
- FR-2: The system must support images (PNG/JPG/WebP, ≤ 5 MB, required alt text) in questions and options.
- FR-3: Quiz questions must have a time limit, correct answer(s) and a points value; the server must reject answers after the deadline.
- FR-4: The system must compute and display a quiz leaderboard, and a final podium.
- FR-5: Surveys must support required questions and one submission per participant.
- FR-6: The system must provide an event analytics summary and PDF and Excel exports with no personally identifying data for anonymous participants.
- FR-7: The system must have exactly two kinds of users: **admin** (logged in, can perform every action) and **audience** (not logged in, participation only). Audience members are identified by an anonymous token and may set a self-chosen nickname; a nickname is not an account.
- FR-8: Admins must be able to create, deactivate/reactivate and reset passwords for other admin accounts; the last active admin cannot be deactivated.
- FR-9: Every host/management endpoint must reject requests without an active admin session; audience must never need to log in or register.
- FR-10: All interface text is English only.
- FR-11: All new participant-facing screens must meet WCAG 2.1 AA.
- FR-12: Shared notes must support submission, own-note edit/delete, one upvote per participant per note (not on own notes), and Open or Moderated mode.
- FR-13: The system must be able to summarize and categorize shared notes using OpenAI or OpenRouter, with the provider, model and the platform owner's API key selected by server configuration. Analysis is started manually by a host only.
- FR-14: Only approved note text may be sent to an AI provider, with no identifiers; AI calls are made server-side and never block the live interaction.
- FR-15: AI output must be schema-validated, labelled as AI-generated, stored, editable by the host, and shown to participants only when the host publishes it.
- FR-16: If AI analysis is unavailable, the system must still show a non-AI word cloud built from word frequency.

## 5. Non-Goals (Out of Scope)

- No billing, plans, usage limits or Stripe integration
- No public API, webhooks, PowerPoint/Google Slides add-ins or Zoom/Teams/Webex apps
- No roles other than admin and audience (no editor, moderator or viewer); no invitations, workspaces, event templates or custom themes/branding
- No audience accounts, sign-up or social login
- No localisation; English only
- No native iOS or Android apps
- No SSO/SAML, SCIM or audit logs
- No AI features other than Shared Notes analysis (summary, categories, keywords); no question clustering, auto-generated polls or AI on other interaction types
- No video, audio or screen sharing
- No cross-event, long-term trend analytics
- No copying of Slido's branding, copy or design assets

## 6. Design Considerations

- Reuse the MVP's presenter layout, bar-chart component and participant tab navigation.
- Quiz screens: large answer buttons with distinct colour **and** shape (not colour alone).
- Leaderboard animations respect `prefers-reduced-motion`.
- Drag-and-drop ranking must have a keyboard-accessible alternative.
- All screens must be usable at 360px width.

## 7. Technical Considerations

- Passwords hashed (argon2 or bcrypt); admin sessions use secure, httpOnly cookies; login attempts rate limited.
- Authorization checked in one shared server-side middleware, not per-page in the UI.
- Build on the MVP stack (Next.js, TypeScript, PostgreSQL, Redis, WebSocket).
- Store quiz scores in Redis sorted sets for the live leaderboard, and persist to PostgreSQL when a question closes.
- Image storage in S3-compatible object storage behind a CDN. Scan or re-encode uploads to strip metadata.
- PDF generation runs in a background job so it cannot block live traffic.
- AI analysis runs in the same background job system. Use a provider-agnostic client (OpenRouter and OpenAI both offer chat-completions-style APIs with JSON output); keep prompts versioned in code and store the model and prompt version with each analysis.
- Treat notes as untrusted input to the model (prompt injection): fixed system prompt, notes in a delimited data block, strict JSON schema validation, no tool use.
- Privacy: note text leaves the system for a third party. Show the host a notice before the first analysis, and let the admin disable AI entirely. Check the provider's data-retention and no-training terms before launch.
- Billing: all AI usage is paid from the platform owner's single API key; admins do not enter keys and are not charged separately. Because every call is a manual click, cost is bounded by the per-event and per-day caps below.
- Cost control: cache the analysis per notes snapshot, limit calls per event and per day, and cap input at about 500 notes per run (batched beyond that).
- Load test: 500 participants answering a timed quiz question within 5 seconds.

## 8. Success Metrics

- Quiz leaderboard updates within 1 second (p95) at 500 participants.
- At least 30% of active hosts use two or more interaction types within 60 days (computed from `interactions.type` per host).
- Report generation completes in under 5 seconds for 5,000 responses.
- AI analysis of 200 notes completes in under 30 seconds (p95), and at least 90% of analyses pass schema validation on the first attempt.

## 9. Open Questions

- Is a quiz participant's nickname enough, or are accounts needed for repeat leaderboards?
- What data retention period applies to responses and uploaded images?
- Which provider and default model for launch (OpenAI or OpenRouter)? (Billing is decided: the platform owner's key.)
- Is sending note text to a third-party AI acceptable for the target customers (education, EU data)? Is a per-event consent notice enough?
- Should participants be told their notes may be processed by AI when they submit?
- Do we need two-factor login for admins? Should password reset move to an email link later (needs an email service)?
- Should billing, integrations and teams be a separate Phase 3 PRD?

## 10. Build Scope: Phase 2a (current build)

Only this subset is being built now, in this order. Everything else in this PRD (ranking, quiz, survey, images, analytics summary, PDF/Excel reports, admin user management) is deferred.

1. Register the new interaction types in the shared model (US-004, limited to `sharedNotes`, `openText`, `rating`).
2. Shared Notes without AI (US-018): write, edit own, upvote, moderate, present, export. The former ideas board is merged into this feature.
3. Open text (US-005) and Rating (US-006).
4. AI analysis for Shared Notes (US-019 to US-022): provider client, manually triggered analysis, word cloud and category charts, host review. Reports are CSV only; PDF/Excel stay deferred.
5. UI improvement across the whole app, following `DESIGN.md` (Warm editorial, light and dark theme) and the antislop rules vendored in `docs/antislop/`.

Decisions for this build: AI usage runs on the platform owner's single API key; analysis is manual only; hosts see a notice before the first analysis, and participants see a one-line disclosure on the notes screen that notes may be summarised by an AI service.

## 11. UI Improvement (Anti-Slop)

- Direction: `DESIGN.md` (Warm editorial, ENERGY 2 / RHYTHM 2 / MOTION 1, light and dark with a toggle).
- Rules: antislop core and the UI, copywriting, human (accessibility), mobile layout and code-comment skills, vendored in `docs/antislop/`. Mode `during` for every story; a final audit story runs mode `after` and fixes all HIGH and MEDIUM findings.
- Done when: every screen uses the design tokens, passes the Delivery Gate and the contrast checker, works at 360px, is keyboard operable, and the e2e test still passes.
