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
    firstInteractionLiveAt: timestamp("first_interaction_live_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("users_email_lowercase", sql`${t.email} = lower(${t.email})`),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("memberships_workspace_user").on(t.workspaceId, t.userId),
    index("memberships_user_idx").on(t.userId),
    check("memberships_role", sql`${t.role} in ('owner', 'admin', 'editor', 'moderator', 'viewer')`),
    check("memberships_status", sql`${t.status} in ('active', 'suspended')`),
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
    type: text("type", { enum: ["poll", "wordcloud", "sharedNotes", "openText", "rating"] }).notNull(),
    title: text("title").notNull(),
    state: text("state", { enum: ["draft", "live", "paused", "closed"] })
      .notNull()
      .default("draft"),
    position: integer("position").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("interactions_type", sql`${t.type} in ('poll', 'wordcloud', 'sharedNotes', 'openText', 'rating')`),
    check("interactions_state", sql`${t.state} in ('draft', 'live', 'paused', 'closed')`),
    index("interactions_event_position_idx").on(t.eventId, t.position),
    uniqueIndex("interactions_one_live_per_event")
      .on(t.eventId)
      .where(sql`${t.state} = 'live'`),
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
