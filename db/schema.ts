import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const appMeta = pgTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    active: boolean("active").notNull().default(true),
    firstLoginAt: timestamp("first_login_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    // Session cookies issued before this moment are rejected; set when the password changes.
    sessionsValidAfter: timestamp("sessions_valid_after", { withTimezone: true }),
    // Defaults to now() so existing users and rows inserted directly count as verified; sign-up sets null.
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }).defaultNow(),
    firstInteractionLiveAt: timestamp("first_interaction_live_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("users_email_lowercase", sql`${t.email} = lower(${t.email})`),
  ],
);

/** Single-use links (verify email, reset password, invitations). Only the hash of the token is stored. */
export const authTokens = pgTable(
  "auth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null for an invitation to someone without an account yet. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose", { enum: ["verify_email", "reset_password", "invite"] }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("auth_tokens_user_idx").on(t.userId),
    check("auth_tokens_purpose", sql`${t.purpose} in ('verify_email', 'reset_password', 'invite')`),
  ],
);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "editor", "moderator", "viewer"] }).notNull(),
    status: text("status", { enum: ["active", "suspended"] })
      .notNull()
      .default("active"),
    /** Why a suspended member is suspended. `seat_limit` is set by the plan and lifted when a seat frees up; null is a manual suspension. */
    suspendedReason: text("suspended_reason", { enum: ["seat_limit"] }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("memberships_workspace_user").on(t.workspaceId, t.userId),
    index("memberships_user_idx").on(t.userId),
    check("memberships_role", sql`${t.role} in ('owner', 'admin', 'editor', 'moderator', 'viewer')`),
    check("memberships_status", sql`${t.status} in ('active', 'suspended')`),
    check("memberships_suspended_reason", sql`${t.suspendedReason} is null or ${t.suspendedReason} in ('seat_limit')`),
  ],
);

/** One row per workspace; a workspace with no row is on Free. Read limits through `getEntitlements` only. */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    plan: text("plan", { enum: ["free", "pro", "team"] })
      .notNull()
      .default("free"),
    status: text("status", { enum: ["active", "trialing", "past_due", "canceled"] })
      .notNull()
      .default("active"),
    interval: text("interval", { enum: ["month", "year"] })
      .notNull()
      .default("month"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    /** When the subscription first turned `past_due`; the grace period counts from here. Null otherwise. */
    pastDueSince: timestamp("past_due_since", { withTimezone: true }),
    provider: text("provider"),
    providerCustomerId: text("provider_customer_id"),
    providerSubscriptionId: text("provider_subscription_id"),
    /** Manual plan that wins over the paid one until `planOverrideUntil` (null = no end). */
    planOverride: text("plan_override", { enum: ["free", "pro", "team"] }),
    planOverrideUntil: timestamp("plan_override_until", { withTimezone: true }),
    planOverrideReason: text("plan_override_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("subscriptions_workspace").on(t.workspaceId),
    check("subscriptions_plan", sql`${t.plan} in ('free', 'pro', 'team')`),
    check("subscriptions_status", sql`${t.status} in ('active', 'trialing', 'past_due', 'canceled')`),
    check("subscriptions_interval", sql`${t.interval} in ('month', 'year')`),
    check("subscriptions_plan_override", sql`${t.planOverride} is null or ${t.planOverride} in ('free', 'pro', 'team')`),
  ],
);

/** One row per provider event already applied, so a redelivered webhook changes nothing. */
export const billingEvents = pgTable(
  "billing_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("billing_events_provider_event").on(t.provider, t.providerEventId)],
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Stored lowercase. */
    email: text("email").notNull(),
    role: text("role", { enum: ["admin", "editor", "moderator", "viewer"] }).notNull(),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    /** The single-use `invite` token behind the link. */
    tokenId: uuid("token_id")
      .notNull()
      .references(() => authTokens.id, { onDelete: "cascade" }),
    /** `expired` is written lazily; treat a pending row past `expires_at` as expired. */
    status: text("status", { enum: ["pending", "accepted", "revoked", "expired"] })
      .notNull()
      .default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("invitations_workspace_idx").on(t.workspaceId),
    uniqueIndex("invitations_pending_email").on(t.workspaceId, t.email).where(sql`${t.status} = 'pending'`),
    check("invitations_role", sql`${t.role} in ('admin', 'editor', 'moderator', 'viewer')`),
    check("invitations_status", sql`${t.status} in ('pending', 'accepted', 'revoked', 'expired')`),
  ],
);

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Who created the event; editors may only delete what they created. */
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    joinCode: text("join_code").notNull().unique(),
    moderationMode: text("moderation_mode", { enum: ["open", "moderated"] })
      .notNull()
      .default("open"),
    peakParticipants: integer("peak_participants").notNull().default(0),
    /** When the host accepted that approved note text is sent to a third-party AI service. */
    aiNoticeAcceptedAt: timestamp("ai_notice_accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("events_name_length", sql`char_length(${t.name}) between 1 and 80`),
    check("events_join_code_format", sql`${t.joinCode} ~ '^[0-9]{4,6}$'`),
    check("events_moderation_mode", sql`${t.moderationMode} in ('open', 'moderated')`),
    check("events_dates_order", sql`${t.endsAt} >= ${t.startsAt}`),
  ],
);

export const participants = pgTable("participants", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  nickname: text("nickname"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
});

export const interactions = pgTable(
  "interactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    type: text("type", { enum: ["poll", "wordcloud", "sharedNotes", "openText", "rating", "qa", "ranking"] }).notNull(),
    title: text("title").notNull(),
    state: text("state", { enum: ["draft", "live", "paused", "closed"] })
      .notNull()
      .default("draft"),
    position: integer("position").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("interactions_type", sql`${t.type} in ('poll', 'wordcloud', 'sharedNotes', 'openText', 'rating', 'qa', 'ranking')`),
    check("interactions_state", sql`${t.state} in ('draft', 'live', 'paused', 'closed')`),
    index("interactions_event_position_idx").on(t.eventId, t.position),
    uniqueIndex("interactions_one_live_per_event")
      .on(t.eventId)
      .where(sql`${t.state} = 'live'`),
  ],
);

/** Reusable content of a workspace: one interaction or a whole event's list. Content only, never responses. */
export const templates = pgTable(
  "templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["interaction", "event"] }).notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("templates_kind", sql`${t.kind} in ('interaction', 'event')`),
    index("templates_workspace_idx").on(t.workspaceId),
  ],
);

export const templateItems = pgTable(
  "template_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => templates.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    type: text("type", { enum: ["poll", "wordcloud", "sharedNotes", "openText", "rating", "qa", "ranking"] }).notNull(),
    title: text("title").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    check("template_items_type", sql`${t.type} in ('poll', 'wordcloud', 'sharedNotes', 'openText', 'rating', 'qa', 'ranking')`),
    index("template_items_template_position_idx").on(t.templateId, t.position),
  ],
);

export const pollVotes = pgTable(
  "poll_votes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    interactionId: uuid("interaction_id")
      .notNull()
      .references(() => interactions.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    optionIds: jsonb("option_ids").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("poll_votes_one_per_participant").on(t.interactionId, t.participantId)],
);

export const wordcloudEntries = pgTable(
  "wordcloud_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    interactionId: uuid("interaction_id")
      .notNull()
      .references(() => interactions.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    normalizedWord: text("normalized_word").notNull(),
    /** Blocked by the profanity filter: stored, but never returned in results. */
    hidden: boolean("hidden").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("wordcloud_entries_interaction_idx").on(t.interactionId),
    index("wordcloud_entries_participant_idx").on(t.interactionId, t.participantId),
  ],
);

export const questions = pgTable(
  "questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    /** The `qa` interaction the question belongs to. */
    interactionId: uuid("interaction_id")
      .notNull()
      .references(() => interactions.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    /** Null for anonymous questions. */
    authorName: text("author_name"),
    status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull(),
    answered: boolean("answered").notNull().default(false),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("questions_text_length", sql`char_length(${t.text}) between 1 and 300`),
    check("questions_status", sql`${t.status} in ('pending', 'approved', 'rejected')`),
    index("questions_event_status_idx").on(t.eventId, t.status),
    index("questions_interaction_idx").on(t.interactionId),
  ],
);

export const questionVotes = pgTable(
  "question_votes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("question_votes_one_per_participant").on(t.questionId, t.participantId)],
);

export const sharedNotes = pgTable(
  "shared_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    interactionId: uuid("interaction_id")
      .notNull()
      .references(() => interactions.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    /** Null for anonymous notes. */
    authorName: text("author_name"),
    status: text("status", { enum: ["pending", "approved", "rejected"] })
      .notNull()
      .default("approved"),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("shared_notes_text_length", sql`char_length(${t.text}) between 1 and 5000`),
    check("shared_notes_status", sql`${t.status} in ('pending', 'approved', 'rejected')`),
    index("shared_notes_interaction_status_idx").on(t.interactionId, t.status),
    index("shared_notes_participant_idx").on(t.interactionId, t.participantId),
  ],
);

export const sharedNoteVotes = pgTable(
  "shared_note_votes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteId: uuid("note_id")
      .notNull()
      .references(() => sharedNotes.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("shared_note_votes_one_per_participant").on(t.noteId, t.participantId)],
);

export const openTextResponses = pgTable(
  "open_text_responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    interactionId: uuid("interaction_id")
      .notNull()
      .references(() => interactions.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    /** Hidden by the host: stored, never sent to participants or the presenter. */
    hidden: boolean("hidden").notNull().default(false),
    highlighted: boolean("highlighted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("open_text_responses_text_length", sql`char_length(${t.text}) between 1 and 300`),
    index("open_text_responses_interaction_idx").on(t.interactionId, t.createdAt),
    index("open_text_responses_participant_idx").on(t.interactionId, t.participantId),
  ],
);

export const ratingResponses = pgTable(
  "rating_responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    interactionId: uuid("interaction_id")
      .notNull()
      .references(() => interactions.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    value: integer("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("rating_responses_one_per_participant").on(t.interactionId, t.participantId),
    check("rating_responses_value_range", sql`${t.value} between 1 and 10`),
  ],
);

export const rankingResponses = pgTable(
  "ranking_responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    interactionId: uuid("interaction_id")
      .notNull()
      .references(() => interactions.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    /** Option ids, first place first. */
    order: jsonb("order").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("ranking_responses_one_per_participant").on(t.interactionId, t.participantId)],
);

/**
 * One row per AI `complete()` call, used to enforce the per-event and per-day caps.
 * Stores no prompt or note text. `event_id` is set null (not cascaded) when an event is
 * deleted so the daily cap cannot be reset by deleting events.
 */
export const aiCalls = pgTable(
  "ai_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_calls_event_idx").on(t.eventId),
    index("ai_calls_created_idx").on(t.createdAt),
  ],
);

export const noteAnalyses = pgTable(
  "note_analyses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    interactionId: uuid("interaction_id")
      .notNull()
      .references(() => interactions.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["queued", "running", "done", "failed"] })
      .notNull()
      .default("queued"),
    /** Hash of the approved notes the analysis was started from. */
    notesSnapshotHash: text("notes_snapshot_hash").notNull(),
    noteCount: integer("note_count").notNull(),
    summary: text("summary"),
    categories: jsonb("categories"),
    keywords: jsonb("keywords"),
    edited: boolean("edited").notNull().default(false),
    published: boolean("published").notNull().default(false),
    model: text("model"),
    promptVersion: text("prompt_version"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    check("note_analyses_status", sql`${t.status} in ('queued', 'running', 'done', 'failed')`),
    index("note_analyses_interaction_idx").on(t.interactionId, t.createdAt),
  ],
);
