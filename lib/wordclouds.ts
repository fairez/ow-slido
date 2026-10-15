import { and, eq, sql } from "drizzle-orm";
import { interactions, participants, wordcloudEntries } from "@/db/schema";
import { getDb } from "@/lib/db";
import { isProfane } from "@/lib/profanity";
import { publish } from "@/lib/realtime/publisher";
import {
  WORDCLOUD_MAX_ENTRIES,
  WORDCLOUD_MIN_ENTRIES,
  WORDCLOUD_PROMPT_MAX,
  WORDCLOUD_WORD_MAX,
} from "@/lib/wordcloud-limits";

export { WORDCLOUD_MAX_ENTRIES, WORDCLOUD_MIN_ENTRIES, WORDCLOUD_PROMPT_MAX, WORDCLOUD_WORD_MAX };

export type WordcloudConfig = { prompt: string; maxEntriesPerParticipant: number };
export type WordcloudInput = { title?: string; config: Partial<WordcloudConfig> };

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validates a word cloud body. With `partial`, absent fields are skipped (PATCH). */
export function parseWordcloudInput(body: unknown, partial: boolean): Parsed<WordcloudInput> {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid request body" };
  const b = body as Record<string, unknown>;
  const value: WordcloudInput = { config: {} };

  if (!partial || b.prompt !== undefined) {
    const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
    if (!prompt) return { ok: false, error: "Prompt is required" };
    if (prompt.length > WORDCLOUD_PROMPT_MAX) {
      return { ok: false, error: `Prompt must be at most ${WORDCLOUD_PROMPT_MAX} characters` };
    }
    value.title = prompt;
    value.config.prompt = prompt;
  }
  if (!partial || b.maxEntriesPerParticipant !== undefined) {
    const n = b.maxEntriesPerParticipant;
    if (
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < WORDCLOUD_MIN_ENTRIES ||
      n > WORDCLOUD_MAX_ENTRIES
    ) {
      return {
        ok: false,
        error: `Entries per participant must be a whole number from ${WORDCLOUD_MIN_ENTRIES} to ${WORDCLOUD_MAX_ENTRIES}`,
      };
    }
    value.config.maxEntriesPerParticipant = n;
  }
  return { ok: true, value };
}

export function wordcloudConfig(partial: Partial<WordcloudConfig>, title = ""): WordcloudConfig {
  return {
    prompt: partial.prompt ?? title,
    maxEntriesPerParticipant: partial.maxEntriesPerParticipant ?? 3,
  };
}

export const normalizeWord = (raw: string) => raw.trim().toLowerCase().replace(/\s+/g, " ");

export type WordCount = { word: string; count: number };
export type WordcloudResults = { interactionId: string; words: WordCount[]; total: number };

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Merged counts of identical words, most frequent first; hidden (profane) entries are excluded. */
export async function getWordcloudResults(
  interactionId: string,
  db: Db | Tx = getDb(),
): Promise<WordcloudResults> {
  const rows = await db
    .select({ word: wordcloudEntries.normalizedWord, count: sql<number>`count(*)::int` })
    .from(wordcloudEntries)
    .where(and(eq(wordcloudEntries.interactionId, interactionId), eq(wordcloudEntries.hidden, false)))
    .groupBy(wordcloudEntries.normalizedWord)
    .orderBy(sql`count(*) desc`, wordcloudEntries.normalizedWord);
  return { interactionId, words: rows, total: rows.reduce((sum, r) => sum + r.count, 0) };
}

export type WordResult =
  | { ok: true; remaining: number }
  | { ok: false; status: 400 | 404 | 409; error: string };

export async function submitWord(
  interactionId: string,
  participantId: string,
  rawWord: unknown,
): Promise<WordResult> {
  const outcome = await getDb().transaction(
    async (tx): Promise<WordResult & { eventId?: string; visible?: boolean }> => {
      // Share lock: closing (an UPDATE) waits for in-flight submissions.
      const [row] = await tx.select().from(interactions).where(eq(interactions.id, interactionId)).for("share");
      if (!row || row.type !== "wordcloud") return { ok: false, status: 404, error: "Interaction not found" };
      // Row lock serialises one participant's submissions so the limit can't be raced.
      const [participant] = await tx
        .select({ eventId: participants.eventId })
        .from(participants)
        .where(eq(participants.id, participantId))
        .for("update");
      if (!participant || participant.eventId !== row.eventId) {
        return { ok: false, status: 404, error: "Interaction not found" };
      }
      if (row.state !== "live") return { ok: false, status: 409, error: "Submissions are not open" };

      const word = typeof rawWord === "string" ? normalizeWord(rawWord) : "";
      if (!word) return { ok: false, status: 400, error: "Enter a word" };
      if (word.length > WORDCLOUD_WORD_MAX) {
        return { ok: false, status: 400, error: `Words must be at most ${WORDCLOUD_WORD_MAX} characters` };
      }

      const { maxEntriesPerParticipant: max } = wordcloudConfig(
        row.config as Partial<WordcloudConfig>,
        row.title,
      );
      const [{ used }] = await tx
        .select({ used: sql<number>`count(*)::int` })
        .from(wordcloudEntries)
        .where(
          and(
            eq(wordcloudEntries.interactionId, interactionId),
            eq(wordcloudEntries.participantId, participantId),
          ),
        );
      if (used >= max) {
        return { ok: false, status: 409, error: "You have used all your entries" };
      }

      const hidden = isProfane(word);
      await tx
        .insert(wordcloudEntries)
        .values({ interactionId, participantId, normalizedWord: word, hidden });
      await tx
        .update(participants)
        .set({ firstResponseAt: sql`coalesce(${participants.firstResponseAt}, now())` })
        .where(eq(participants.id, participantId));
      // A blocked word looks accepted to the sender but changes nothing for anyone else.
      return { ok: true, remaining: max - used - 1, eventId: row.eventId, visible: !hidden };
    },
  );

  if (!outcome.ok) return outcome;
  if (outcome.visible && outcome.eventId) {
    publish(outcome.eventId, "wordcloud:words", await getWordcloudResults(interactionId));
  }
  return { ok: true, remaining: outcome.remaining };
}
