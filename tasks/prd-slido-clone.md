# PRD: Slido Clone (Live Audience Interaction Platform)

> **Assumptions (change if wrong):** MVP scope · hosts sign up, participants join anonymously with a code · stack is open (recommendation in Technical Considerations) · primary users are presenters, trainers, teachers and event organizers · original name and branding, no Slido assets or copy · **Phase 2 (`prd-slido-clone-full.md`) builds on this PRD and replaces the single moderator link with an admin role; the data model here is built so that change needs no rework.**

## 1. Introduction/Overview

A web app where a host runs live polls, word clouds and Q&A with an audience. Participants join from a phone or laptop with a short code, with no account and no install. Results update live on the host's presenter screen. This solves passive, one-way meetings and events, where hosts get no structured feedback and quieter attendees never speak up.

## 2. Goals

- A participant can join and submit a first response in under 10 seconds.
- A host can create and launch a poll in under 2 minutes.
- Live results reach the presenter screen within 1 second (p95) for up to 1,000 concurrent participants.
- Q&A can be moderated so that unreviewed questions never appear publicly.
- Works on the latest Chrome, Safari, Firefox and Edge, and on iOS Safari and Android Chrome.

## 3. User Stories

### US-001: Host registration and login
**Description:** As a host, I want to sign up and log in so that I can manage my events.

**Acceptance Criteria:**
- [ ] Sign up with email and password; log in; log out
- [ ] Passwords hashed; invalid credentials show an error message
- [ ] Accounts live in a `users` table: `email` (unique), `password_hash`, `role` (only value: `admin`), `active` (default true), `created_at`
- [ ] Login attempts are rate limited per IP and per email
- [ ] Unauthenticated users are redirected from `/dashboard` to `/login`
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-002: Create an event
**Description:** As a host, I want to create an event with a name and date so that I have a space for my session.

**Acceptance Criteria:**
- [ ] "New event" form with name (required, max 80 chars) and start/end date
- [ ] On save, the event gets a unique 4–6 digit join code and a join URL
- [ ] Event appears in the dashboard list, sorted by start date
- [ ] Host can rename and delete an event (delete asks for confirmation)
- [ ] Host can duplicate an event: interactions are copied in `draft` state, results and Q&A are not, and a new join code is issued
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-003: Participant joins by code
**Description:** As a participant, I want to enter a code on the home page so that I can join without an account.

**Acceptance Criteria:**
- [ ] Home page has one code input and a "Join" button
- [ ] Valid code opens the participant view; invalid code shows "Event not found"
- [ ] Visiting the join URL directly skips the code step
- [ ] No sign-up is required; an anonymous token is stored in the browser
- [ ] A `participants` record is created per token and event: `token`, `event_id`, `joined_at`, `nickname` (nullable); no other personal data
- [ ] Layout works at 360px width
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-004: Interaction base model
**Description:** As a developer, I need one shared model for all live interactions so that new types can be added without migrating existing data.

**Acceptance Criteria:**
- [ ] `interactions` table: `id`, `event_id`, `type` (`poll` | `wordcloud` in the MVP), `title`, `state` (`draft` | `live` | `closed`), `position`, JSON `config`, `created_at`
- [ ] Type-specific settings (options, multi-select, max entries, show-results flag) live in `config`; responses are stored in a table keyed by `interaction_id` and `participant_id`
- [ ] A partial unique index allows at most one `live` interaction per event
- [ ] Q&A is a separate per-event stream, not an interaction
- [ ] Migration runs successfully
- [ ] Typecheck/lint passes

### US-005: Create a multiple-choice poll
**Description:** As a host, I want to add a poll with 2–10 options so that I can ask the audience a question.

**Acceptance Criteria:**
- [ ] Form: question (required), 2–10 options, single or multi-select toggle
- [ ] Poll is saved in `draft` state and listed under the event
- [ ] Host can edit, reorder, duplicate and delete draft polls
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-006: Run a poll live
**Description:** As a host, I want to start and close a poll so that participants can vote only when I choose.

**Acceptance Criteria:**
- [ ] "Start" sets the poll to `live`; only one poll is live per event at a time
- [ ] Participants see the live poll within 1 second without refreshing
- [ ] "Close" stops voting; participants see "Voting closed"
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-007: Vote on a poll
**Description:** As a participant, I want to vote and see confirmation so that I know my answer counted.

**Acceptance Criteria:**
- [ ] Participant selects option(s) and taps "Submit"
- [ ] A participant can vote only once per poll (enforced on the server)
- [ ] After voting, a confirmation is shown; results are shown only if the host enabled "show results to participants"
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-008: Live results on the presenter screen
**Description:** As a host, I want a full-screen results view so that I can project it to the room.

**Acceptance Criteria:**
- [ ] Presenter view at `/present/:eventId` shows the question, live bar chart (count and %), total votes
- [ ] Join code and QR code are shown in a corner
- [ ] Bars update live without refresh
- [ ] Host can go to previous/next poll with keyboard arrows
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-009: Word cloud
**Description:** As a host, I want to run a word cloud so that I can collect short audience input visually.

**Acceptance Criteria:**
- [ ] Host creates a word cloud prompt with a max entries per participant (1–5)
- [ ] Participants submit words (max 25 chars each)
- [ ] Presenter view renders words sized by frequency, updated live
- [ ] Words are lowercased and trimmed; matching words are merged
- [ ] Profanity filter hides blocked words
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-010: Submit a question
**Description:** As a participant, I want to ask a question, optionally anonymously, so that the host can answer it.

**Acceptance Criteria:**
- [ ] Q&A tab with a text box (max 300 chars) and an optional name field
- [ ] Anonymous by default; no name stored if left blank
- [ ] In moderated mode, the participant sees "Your question is waiting for approval"
- [ ] Rate limit: max 5 questions per participant per minute
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-011: Upvote questions
**Description:** As a participant, I want to upvote questions so that the most important ones rise to the top.

**Acceptance Criteria:**
- [ ] One upvote per participant per question; tapping again removes it
- [ ] List sortable by Popular and Recent
- [ ] Counts update live
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-012: Moderate questions
**Description:** As a moderator or host, I want to review questions so that inappropriate ones never reach the audience.

**Acceptance Criteria:**
- [ ] Event setting: Open or Moderated Q&A
- [ ] Moderation queue lists pending questions with Approve and Reject buttons
- [ ] Approved questions appear to participants within 1 second; rejected ones never do
- [ ] Actions: mark as answered, pin, delete
- [ ] Host can generate a moderator link per event; it contains a signed token scoped to that event, and opening it grants access to the moderation queue only (no account, no other pages or endpoints)
- [ ] Host can revoke and regenerate the link; a revoked link stops working immediately
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-013: Export results
**Description:** As a host, I want to export results so that I can share them after the event.

**Acceptance Criteria:**
- [ ] "Export CSV" on the event page downloads polls, votes per option, word counts and questions with upvotes
- [ ] Anonymous participants contain no identifying data in the file
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

### US-014: Presence and engagement metrics
**Description:** As a host, I want to see how many participants are connected, and as a product owner I want engagement data so that the success metrics can be measured.

**Acceptance Criteria:**
- [ ] Host dashboard shows the live participant count per event, updated live
- [ ] Peak concurrent participants is stored per event
- [ ] Per participant, store `joined_at` and `first_response_at`; per host, store `first_login_at` and `first_interaction_live_at`
- [ ] Stored timestamps contain no personal data beyond what US-003 already records
- [ ] Typecheck/lint passes
- [ ] **Verify in browser using dev-browser skill**

## 4. Functional Requirements

- FR-1: The system must let hosts register, log in and log out with email and password.
- FR-2: The system must let a host create, rename, duplicate and delete events.
- FR-3: Each event must have a unique numeric join code and join URL.
- FR-4: The system must let participants join an event by code or URL without creating an account.
- FR-5: The system must support multiple-choice polls (single or multi-select, 2–10 options).
- FR-6: The system must support word cloud prompts.
- FR-7: Every interaction is a row in a shared `interactions` table with a `type`, a JSON `config` and a state (`draft`, `live` or `closed`); only one interaction may be `live` per event.
- FR-8: When a host changes the live interaction, all connected participants must see the change within 1 second.
- FR-9: The server must reject a second vote from the same participant on the same poll.
- FR-10: The system must provide a full-screen presenter view with live results, join code and QR code.
- FR-11: The system must provide a Q&A stream per event with submit, upvote, sort, pin, answer and delete.
- FR-12: The system must support Open and Moderated Q&A modes; in Moderated mode, only approved questions are visible to participants.
- FR-13: The system must apply a profanity filter to word cloud entries and questions.
- FR-14: The system must rate limit join, vote and submit endpoints per IP and per participant token.
- FR-15: The system must let hosts export event data to CSV.
- FR-16: The system must show a live participant count on the host dashboard and store peak concurrency per event.
- FR-17: The system must record the timestamps needed to compute the success metrics in section 8 (US-014).
- FR-18: A moderator link must be scoped to one event and to the moderation queue, and must be revocable by the host.

## 5. Non-Goals (Out of Scope)

- No quizzes, ratings, ranking, surveys or ideas board (covered by the Phase 2 PRD)
- No PowerPoint, Google Slides, Teams, Zoom or Webex integrations
- No payments, plans or billing (no free-tier limits are defined for the MVP)
- No SSO, SAML or team workspaces, and no roles beyond the single moderator link (Phase 2 replaces it with an admin role)
- No native mobile apps
- No AI features (summaries, question clustering)
- No localisation beyond English
- No copying of Slido's branding, copy or design assets

## 6. Design Considerations

- Participant UI is mobile-first with large tap targets (min 44px) and a single-column layout.
- Presenter view has high-contrast, large type readable from the back of a room.
- Charts must use more than colour to distinguish options (labels and values shown).
- Meet WCAG 2.1 AA: keyboard navigation, visible focus, screen-reader labels on the voting controls.

## 7. Technical Considerations

- **Data model:** `users`, `events`, `participants`, `interactions` (shared base, see US-004), responses, questions. Phase 2 adds interaction types by extending `interactions.type` and `config`.
- **Recommended stack:** Next.js and TypeScript; PostgreSQL; Redis for live counters, vote dedup and pub/sub; WebSocket (Socket.IO) with a polling fallback.
- Vote dedup enforced server-side by participant token plus poll ID (unique constraint).
- Hosts and moderators authenticate with sessions; participants get a signed anonymous token.
- Keep the participant bundle small (target < 150 KB gzipped) for slow mobile networks.
- Load test: 1,000 concurrent participants voting within 10 seconds.
- Privacy: no personal data stored for anonymous participants; support event deletion that removes all related data.

## 8. Success Metrics

Metrics are computed from the timestamps stored in US-014.

- Median time from the join page to first response is under 10 seconds.
- Participation rate (responders / joined) is above 60% in test events.
- p95 vote-to-screen latency is under 1 second at 1,000 concurrent participants.
- A new host can create and run a first poll in under 2 minutes without help.
- Zero unmoderated questions visible in Moderated mode during testing.

## 9. Open Questions

- Product name and domain? (Must differ from Slido.)
- Self-hosted vs managed realtime service (cost vs control)?
- Data retention period for ended events? (Proposed default: 12 months, then delete.)
- Is education a target market (affects FERPA/COPPA and privacy requirements)?
