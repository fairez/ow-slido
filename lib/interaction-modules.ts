import { and, desc, eq, sql } from "drizzle-orm";
import {
  interactions,
  noteAnalyses,
  openTextResponses,
  pollVotes,
  questions,
  questionVotes,
  quizAnswers,
  rankingResponses,
  ratingResponses,
  sharedNotes,
  sharedNoteVotes,
  wordcloudEntries,
} from "@/db/schema";
import { isAiConfigured } from "@/lib/ai/config";
import { getDb } from "@/lib/db";
import type { MessageKey, TParams } from "@/lib/i18n";
import { parseNewInteractionInput, type OpenTextConfig, type QuizConfig, type RankingConfig, type RatingConfig, type SharedNotesConfig } from "@/lib/interaction-config";
import type { LiveInteraction } from "@/lib/live-view";
import { listPresenterResponses } from "@/lib/open-text";
import { parsePollInput, pollConfig, type PollConfig } from "@/lib/polls";
import type { PresenterState } from "@/lib/presenter";
import { listApprovedQuestions } from "@/lib/questions";
import { getNicknameState } from "@/lib/nickname";
import { computeQuizResults, countQuizAnswers, databaseNowMs, quizTimeLimitSeconds } from "@/lib/quiz";
import { computeResults as computeRankingResults } from "@/lib/ranking";
import { RANKING_MAX_OPTIONS } from "@/lib/ranking-limits";
import { computeResults, getPresenterResults } from "@/lib/rating";
import { listPresenterNotes } from "@/lib/shared-notes";
import { getPollCounts } from "@/lib/votes";
import { getWordcloudResults, parseWordcloudInput, wordcloudConfig, type WordcloudConfig } from "@/lib/wordclouds";

export type InteractionType = (typeof interactions.$inferSelect)["type"];
export type InteractionRow = typeof interactions.$inferSelect;

export const EXPORT_HEADER = ["section", "title", "item", "count", "author"] as const;
export const NOTES_EXPORT_HEADER = ["section", "title", "note", "status", "pinned", "upvotes", "author"] as const;
export const OPEN_TEXT_EXPORT_HEADER = ["section", "title", "response", "highlighted"] as const;
export const RATING_EXPORT_HEADER = ["section", "title", "scale", "average", "total", "value", "count"] as const;
/** `position_1`..`position_10`: submissions that put the option there; columns past the option count stay empty. */
export const RANKING_EXPORT_HEADER = [
  "section",
  "title",
  "rank",
  "option",
  "score",
  "rankings",
  ...Array.from({ length: RANKING_MAX_OPTIONS }, (_, i) => `position_${i + 1}`),
] as const;
export const QUIZ_EXPORT_HEADER = ["section", "title", "option", "correct", "count", "answers", "correct_percent"] as const;
export const ANALYSIS_EXPORT_HEADER = ["section", "title", "kind", "item", "count", "weight", "model", "run_at", "ai_generated", "edited"] as const;

/**
 * One table of a CSV file. `trailing` tables go after the main ones when several interactions
 * are merged into one file (the analysis summary closes the event file).
 */
export type CsvTable = { header: readonly string[]; rows: (string | number)[][]; trailing?: boolean };

export type ConfigResult =
  | { ok: true; value: { title?: string; config: object } }
  | { ok: false; error: MessageKey; params?: TParams };

/** Everything the app needs to know about one interaction type; add a type by registering a module. */
export type InteractionModule = {
  type: InteractionType;
  /** Validates a create (`partial` false) or PATCH (`partial` true) body. */
  validateConfig(body: unknown, partial: boolean): ConfigResult;
  /** Aggregates for the presenter and host, no participant ids. */
  results(interactionId: string): Promise<unknown>;
  /** Tables for the CSV export; no participant ids, emails or IPs. */
  csv(interactionId: string): Promise<CsvTable[]>;
  /** Responses counted in the content library. */
  responseCount(interactionId: string): Promise<number>;
  /** The presenter screen for a live (or closed) interaction of this type; null when the type has none. */
  presenter(row: InteractionRow): Promise<PresenterState | null>;
  /** The participant screen for a live interaction; null when the type has none. */
  live(row: InteractionRow, participantId?: string): Promise<LiveInteraction | null>;
  /** The presenter may keep showing a closed interaction of this type. */
  presentWhenClosed: boolean;
};

const db = () => getDb();

async function loadRow(interactionId: string): Promise<InteractionRow> {
  const [row] = await db().select().from(interactions).where(eq(interactions.id, interactionId));
  if (!row) throw new Error(`interaction ${interactionId} not found`);
  return row;
}

const countOf = async (query: PromiseLike<{ n: number }[]>) => (await query)[0]?.n ?? 0;

/** How many of `max` slots this participant has used; 0 when the participant is unknown. */
async function usedBy(table: typeof wordcloudEntries | typeof sharedNotes | typeof openTextResponses, interactionId: string, participantId?: string) {
  if (!participantId) return 0;
  const [r] = await db()
    .select({ used: sql<number>`count(*)::int` })
    .from(table)
    .where(and(eq(table.interactionId, interactionId), eq(table.participantId, participantId)));
  return r.used;
}

const pollModule: InteractionModule = {
  type: "poll",
  presentWhenClosed: false,
  validateConfig: parsePollInput,
  async results(interactionId) {
    return pollResults(await loadRow(interactionId));
  },
  async csv(interactionId) {
    const row = await loadRow(interactionId);
    const { options, counts } = await pollResults(row);
    return [{ header: EXPORT_HEADER, rows: options.map((o) => ["poll", row.title, o.label, counts[o.id] ?? 0, ""]) }];
  },
  async responseCount(interactionId) {
    return countOf(db().select({ n: sql<number>`count(*)::int` }).from(pollVotes).where(eq(pollVotes.interactionId, interactionId)));
  },
  async presenter(row) {
    return { type: "poll", id: row.id, title: row.title, ...(await pollResults(row)) };
  },
  async live(row) {
    const config = pollConfig(row.config as Partial<PollConfig>);
    return {
      id: row.id,
      type: "poll",
      title: row.title,
      state: "live",
      options: config.options,
      multiSelect: config.multiSelect,
      showResultsToParticipants: config.showResultsToParticipants,
    };
  },
};

async function pollResults(row: InteractionRow) {
  const { options } = pollConfig(row.config as Partial<PollConfig>);
  const { counts, total } = await getPollCounts(row.id, options.map((o) => o.id));
  return { options, counts, total };
}

const wordcloudModule: InteractionModule = {
  type: "wordcloud",
  presentWhenClosed: false,
  validateConfig: parseWordcloudInput,
  results: (interactionId) => getWordcloudResults(interactionId),
  async csv(interactionId) {
    const row = await loadRow(interactionId);
    const { words } = await getWordcloudResults(interactionId);
    return [{ header: EXPORT_HEADER, rows: words.map((w) => ["wordcloud", row.title, w.word, w.count, ""]) }];
  },
  async responseCount(interactionId) {
    return countOf(
      db().select({ n: sql<number>`count(*)::int` }).from(wordcloudEntries).where(eq(wordcloudEntries.interactionId, interactionId)),
    );
  },
  async presenter(row) {
    const { words, total } = await getWordcloudResults(row.id);
    return { type: "wordcloud", id: row.id, title: row.title, words, total };
  },
  async live(row, participantId) {
    const { maxEntriesPerParticipant: max } = wordcloudConfig(row.config as Partial<WordcloudConfig>, row.title);
    const used = await usedBy(wordcloudEntries, row.id, participantId);
    return { id: row.id, type: "wordcloud", title: row.title, state: "live", maxEntries: max, remaining: Math.max(0, max - used) };
  },
};

const qaModule: InteractionModule = {
  type: "qa",
  presentWhenClosed: false,
  validateConfig: (body, partial) => parseNewInteractionInput("qa", body, partial),
  results: (interactionId) => listApprovedQuestions(interactionId),
  async csv(interactionId) {
    const qs = await db()
      .select({ text: questions.text, authorName: questions.authorName, upvotes: sql<number>`count(${questionVotes.id})::int` })
      .from(questions)
      .leftJoin(questionVotes, eq(questionVotes.questionId, questions.id))
      .where(and(eq(questions.interactionId, interactionId), eq(questions.status, "approved")))
      .groupBy(questions.id)
      .orderBy(sql`count(${questionVotes.id}) desc`, desc(questions.createdAt));
    return [{ header: EXPORT_HEADER, rows: qs.map((q) => ["question", "", q.text, q.upvotes, q.authorName ?? ""]) }];
  },
  async responseCount(interactionId) {
    return countOf(
      db()
        .select({ n: sql<number>`count(*)::int` })
        .from(questions)
        .where(and(eq(questions.interactionId, interactionId), sql`${questions.status} <> 'rejected'`)),
    );
  },
  // The Q&A tab and the presenter's question list have their own routes and messages.
  presenter: async () => null,
  live: async () => null,
};

const sharedNotesModule: InteractionModule = {
  type: "sharedNotes",
  presentWhenClosed: true,
  validateConfig: (body, partial) => parseNewInteractionInput("sharedNotes", body, partial),
  results: (interactionId) => listPresenterNotes(interactionId),
  async csv(interactionId) {
    const row = await loadRow(interactionId);
    const notes = await db()
      .select({
        text: sharedNotes.text,
        status: sharedNotes.status,
        pinned: sharedNotes.pinned,
        authorName: sharedNotes.authorName,
        upvotes: sql<number>`count(${sharedNoteVotes.id})::int`,
      })
      .from(sharedNotes)
      .leftJoin(sharedNoteVotes, eq(sharedNoteVotes.noteId, sharedNotes.id))
      .where(eq(sharedNotes.interactionId, interactionId))
      .groupBy(sharedNotes.id)
      .orderBy(sql`count(${sharedNoteVotes.id}) desc`, desc(sharedNotes.createdAt));
    const tables: CsvTable[] = [
      {
        header: NOTES_EXPORT_HEADER,
        rows: notes.map((n) => ["sharedNotes", row.title, n.text, n.status, n.pinned ? "yes" : "no", n.upvotes, n.authorName ?? ""]),
      },
    ];
    const analysis = await analysisRows(row);
    if (analysis.length > 0) tables.push({ header: ANALYSIS_EXPORT_HEADER, rows: analysis, trailing: true });
    return tables;
  },
  async responseCount(interactionId) {
    return countOf(
      db()
        .select({ n: sql<number>`count(*)::int` })
        .from(sharedNotes)
        .where(and(eq(sharedNotes.interactionId, interactionId), sql`${sharedNotes.status} <> 'rejected'`)),
    );
  },
  async presenter(row) {
    if (row.state !== "live" && row.state !== "closed") return null;
    return { type: "sharedNotes", id: row.id, title: row.title, state: row.state, notes: await listPresenterNotes(row.id) };
  },
  async live(row, participantId) {
    const c = row.config as Partial<SharedNotesConfig>;
    const max = c.maxNotesPerParticipant ?? 3;
    const used = await usedBy(sharedNotes, row.id, participantId);
    return {
      id: row.id,
      type: "sharedNotes",
      title: row.title,
      state: "live",
      maxNotes: max,
      remaining: Math.max(0, max - used),
      moderation: c.moderation ?? "open",
      showAuthorNames: c.showAuthorNames ?? false,
      aiDisclosure: isAiConfigured(),
    };
  },
};

/** Only the newest finished run, and only for hosts who ran one; notes are counted, never listed. */
async function analysisRows(row: InteractionRow): Promise<(string | number)[][]> {
  const [a] = await db()
    .select()
    .from(noteAnalyses)
    .where(and(eq(noteAnalyses.interactionId, row.id), eq(noteAnalyses.status, "done")))
    .orderBy(desc(noteAnalyses.createdAt))
    .limit(1);
  if (!a) return [];
  const out: (string | number)[][] = [];
  const meta = [a.model ?? "", (a.finishedAt ?? a.createdAt).toISOString(), "yes", a.edited ? "yes" : "no"];
  const add = (kind: string, item: string, count: number | "", weight: number | "") =>
    out.push(["analysis", row.title, kind, item, count, weight, ...meta]);
  if (a.summary) add("summary", a.summary, "", "");
  for (const c of Array.isArray(a.categories) ? (a.categories as { name?: unknown; noteIds?: unknown }[]) : []) {
    add("category", String(c.name ?? ""), Array.isArray(c.noteIds) ? c.noteIds.length : 0, "");
  }
  for (const k of Array.isArray(a.keywords) ? (a.keywords as { word?: unknown; weight?: unknown }[]) : []) {
    add("keyword", String(k.word ?? ""), "", Number(k.weight) || 0);
  }
  return out;
}

const openTextModule: InteractionModule = {
  type: "openText",
  presentWhenClosed: true,
  validateConfig: (body, partial) => parseNewInteractionInput("openText", body, partial),
  results: (interactionId) => listPresenterResponses(interactionId),
  async csv(interactionId) {
    const row = await loadRow(interactionId);
    // Hidden responses are the host's moderation; they stay out of the file.
    const responses = await db()
      .select({ text: openTextResponses.text, highlighted: openTextResponses.highlighted })
      .from(openTextResponses)
      .where(and(eq(openTextResponses.interactionId, interactionId), eq(openTextResponses.hidden, false)))
      .orderBy(desc(openTextResponses.highlighted), desc(openTextResponses.createdAt));
    return [{ header: OPEN_TEXT_EXPORT_HEADER, rows: responses.map((r) => ["openText", row.title, r.text, r.highlighted ? "yes" : "no"]) }];
  },
  async responseCount(interactionId) {
    return countOf(
      db().select({ n: sql<number>`count(*)::int` }).from(openTextResponses).where(eq(openTextResponses.interactionId, interactionId)),
    );
  },
  async presenter(row) {
    if (row.state !== "live" && row.state !== "closed") return null;
    return { type: "openText", id: row.id, title: row.title, state: row.state, responses: await listPresenterResponses(row.id) };
  },
  async live(row, participantId) {
    const max = (row.config as Partial<OpenTextConfig>).maxResponsesPerParticipant ?? 1;
    const used = await usedBy(openTextResponses, row.id, participantId);
    return { id: row.id, type: "openText", title: row.title, state: "live", maxResponses: max, remaining: Math.max(0, max - used) };
  },
};

const scaleOf = (row: InteractionRow): RatingConfig["scale"] =>
  (row.config as Partial<RatingConfig>).scale === "numeric10" ? "numeric10" : "stars5";

const ratingModule: InteractionModule = {
  type: "rating",
  presentWhenClosed: true,
  validateConfig: (body, partial) => parseNewInteractionInput("rating", body, partial),
  async results(interactionId) {
    const row = await loadRow(interactionId);
    return getPresenterResults(row.id, row.config);
  },
  async csv(interactionId) {
    const row = await loadRow(interactionId);
    const scale = scaleOf(row);
    const results = await computeResults(db(), interactionId, scale);
    return [
      {
        header: RATING_EXPORT_HEADER,
        rows: results.distribution.map((count, i) => ["rating", row.title, scale, results.average ?? "", results.total, i + 1, count]),
      },
    ];
  },
  async responseCount(interactionId) {
    return countOf(
      db().select({ n: sql<number>`count(*)::int` }).from(ratingResponses).where(eq(ratingResponses.interactionId, interactionId)),
    );
  },
  async presenter(row) {
    if (row.state !== "live" && row.state !== "closed") return null;
    return { type: "rating", id: row.id, title: row.title, state: row.state, results: await getPresenterResults(row.id, row.config) };
  },
  async live(row, participantId) {
    let mine: number | null = null;
    if (participantId) {
      const [r] = await db()
        .select({ value: ratingResponses.value })
        .from(ratingResponses)
        .where(and(eq(ratingResponses.interactionId, row.id), eq(ratingResponses.participantId, participantId)));
      mine = r?.value ?? null;
    }
    return { id: row.id, type: "rating", title: row.title, state: "live", scale: scaleOf(row), mine };
  },
};

const rankingModule: InteractionModule = {
  type: "ranking",
  presentWhenClosed: true,
  validateConfig: (body, partial) => parseNewInteractionInput("ranking", body, partial),
  async results(interactionId) {
    const row = await loadRow(interactionId);
    return computeRankingResults(db(), interactionId, row.config);
  },
  async csv(interactionId) {
    const row = await loadRow(interactionId);
    const results = await computeRankingResults(db(), interactionId, row.config);
    return [
      {
        header: RANKING_EXPORT_HEADER,
        rows: results.options.map((o) => [
          "ranking",
          row.title,
          o.rank,
          o.text,
          o.score,
          results.total,
          ...Array.from({ length: RANKING_MAX_OPTIONS }, (_, i) => o.positions[i] ?? ""),
        ]),
      },
    ];
  },
  async responseCount(interactionId) {
    return countOf(
      db().select({ n: sql<number>`count(*)::int` }).from(rankingResponses).where(eq(rankingResponses.interactionId, interactionId)),
    );
  },
  async presenter(row) {
    if (row.state !== "live" && row.state !== "closed") return null;
    return {
      type: "ranking",
      id: row.id,
      title: row.title,
      state: row.state,
      results: await computeRankingResults(db(), row.id, row.config),
    };
  },
  async live(row, participantId) {
    const c = row.config as Partial<RankingConfig>;
    let mine: string[] | null = null;
    if (participantId) {
      const [r] = await db()
        .select({ order: rankingResponses.order })
        .from(rankingResponses)
        .where(and(eq(rankingResponses.interactionId, row.id), eq(rankingResponses.participantId, participantId)));
      mine = r?.order ?? null;
    }
    return {
      id: row.id,
      type: "ranking",
      title: row.title,
      state: "live",
      prompt: c.prompt ?? "",
      options: Array.isArray(c.options) ? c.options : [],
      mine,
    };
  },
};

const quizModule: InteractionModule = {
  type: "quiz",
  presentWhenClosed: true,
  validateConfig: (body, partial) => parseNewInteractionInput("quiz", body, partial),
  async results(interactionId) {
    return computeQuizResults(db(), interactionId, (await loadRow(interactionId)).config);
  },
  async csv(interactionId) {
    const row = await loadRow(interactionId);
    const results = await computeQuizResults(db(), interactionId, row.config);
    return [
      {
        header: QUIZ_EXPORT_HEADER,
        rows: results.options.map((o) => [
          "quiz",
          row.title,
          o.text,
          o.correct ? "yes" : "no",
          o.count,
          results.total,
          results.correctPercent ?? "",
        ]),
      },
    ];
  },
  responseCount: countQuizAnswers,
  async presenter(row) {
    if (row.state !== "live" && row.state !== "closed") return null;
    const c = row.config as Partial<QuizConfig>;
    const results = await computeQuizResults(db(), row.id, row.config);
    return {
      type: "quiz",
      id: row.id,
      title: row.title,
      state: row.state,
      prompt: c.prompt ?? "",
      options: (Array.isArray(c.options) ? c.options : []).map((o) => ({ id: o.id, text: o.text })),
      timeLimitSeconds: quizTimeLimitSeconds(c),
      deadlineAt: row.deadlineAt ? row.deadlineAt.getTime() : null,
      serverNow: await databaseNowMs(),
      total: results.total,
      // Per-option counts and the correct options are held back until the host closes the question.
      results: row.state === "closed" ? results : null,
    };
  },
  async live(row, participantId) {
    const c = row.config as Partial<QuizConfig>;
    let mine: string[] | null = null;
    if (participantId) {
      const [r] = await db()
        .select({ optionIds: quizAnswers.optionIds })
        .from(quizAnswers)
        .where(and(eq(quizAnswers.interactionId, row.id), eq(quizAnswers.participantId, participantId)));
      mine = r?.optionIds ?? null;
    }
    return {
      id: row.id,
      type: "quiz",
      title: row.title,
      state: "live",
      prompt: c.prompt ?? "",
      options: Array.isArray(c.options) ? c.options : [],
      multiple: (c.correctOptionIds?.length ?? 0) > 1,
      timeLimitSeconds: quizTimeLimitSeconds(c),
      deadlineAt: row.deadlineAt ? row.deadlineAt.getTime() : null,
      serverNow: await databaseNowMs(),
      mine,
      ...(await getNicknameState(row.eventId, participantId)),
    };
  },
};

/** Registration order is the order of tables in the combined event CSV. */
export const INTERACTION_MODULES: readonly InteractionModule[] = [
  pollModule,
  wordcloudModule,
  qaModule,
  sharedNotesModule,
  openTextModule,
  ratingModule,
  rankingModule,
  quizModule,
];

const byType = new Map<string, InteractionModule>(INTERACTION_MODULES.map((m) => [m.type, m]));

/** The module for a stored type; throws when a type was added to the schema but never registered. */
export function interactionModule(type: string): InteractionModule {
  const found = byType.get(type);
  if (!found) throw new Error(`interaction type "${type}" has no module`);
  return found;
}
