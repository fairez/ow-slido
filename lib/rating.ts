import { and, eq, sql } from "drizzle-orm";
import { events, interactions, participants, ratingResponses } from "@/db/schema";
import { getDb } from "@/lib/db";
import type { RatingConfig } from "@/lib/interaction-config";
import { publish } from "@/lib/realtime/publisher";
import { RATING_SCALE_MAX } from "@/lib/rating-limits";

export { RATING_SCALE_MAX };

export type RatingResults = {
  interactionId: string;
  scale: RatingConfig["scale"];
  total: number;
  /** Mean rounded to two decimals; null until the first rating. */
  average: number | null;
  /** Count per value; index 0 is the value 1. */
  distribution: number[];
};

const scaleOf = (config: unknown): RatingConfig["scale"] =>
  ((config ?? {}) as Partial<RatingConfig>).scale === "numeric10" ? "numeric10" : "stars5";

type Db = Pick<ReturnType<typeof getDb>, "select">;

export async function computeResults(db: Db, interactionId: string, scale: RatingConfig["scale"]): Promise<RatingResults> {
  const rows = await db
    .select({ value: ratingResponses.value, n: sql<number>`count(*)::int` })
    .from(ratingResponses)
    .where(eq(ratingResponses.interactionId, interactionId))
    .groupBy(ratingResponses.value);
  const distribution = Array<number>(RATING_SCALE_MAX[scale]).fill(0);
  let total = 0;
  let sum = 0;
  for (const r of rows) {
    if (r.value < 1 || r.value > distribution.length) continue;
    distribution[r.value - 1] = r.n;
    total += r.n;
    sum += r.value * r.n;
  }
  return { interactionId, scale, total, average: total ? Math.round((sum / total) * 100) / 100 : null, distribution };
}

export type SubmitRatingResult =
  | { ok: true; value: number; results: RatingResults }
  | { ok: false; status: 400 | 404 | 409; error: string };

export async function submitRating(
  interactionId: string,
  participantId: string,
  rawValue: unknown,
): Promise<SubmitRatingResult> {
  type Outcome =
    | { error: 400 | 404 | 409; message: string }
    | { error?: undefined; eventId: string; scale: RatingConfig["scale"]; value: number };
  const outcome: Outcome = await getDb().transaction(async (tx): Promise<Outcome> => {
    // Share lock: closing (an UPDATE) waits for in-flight writes.
    const [interaction] = await tx.select().from(interactions).where(eq(interactions.id, interactionId)).for("share");
    if (!interaction || interaction.type !== "rating") return { error: 404 as const, message: "Interaction not found" };
    const scale = scaleOf(interaction.config);
    const max = RATING_SCALE_MAX[scale];
    if (typeof rawValue !== "number" || !Number.isInteger(rawValue) || rawValue < 1 || rawValue > max) {
      return { error: 400 as const, message: `Rating must be a whole number from 1 to ${max}` };
    }
    const [participant] = await tx
      .select({ eventId: participants.eventId })
      .from(participants)
      .where(eq(participants.id, participantId));
    if (!participant || participant.eventId !== interaction.eventId) {
      return { error: 404 as const, message: "Interaction not found" };
    }
    if (interaction.state !== "live") return { error: 409 as const, message: "This question is not open" };

    const inserted = await tx
      .insert(ratingResponses)
      .values({ interactionId, participantId, value: rawValue })
      .onConflictDoNothing()
      .returning({ id: ratingResponses.id });
    if (inserted.length === 0) return { error: 409 as const, message: "You have already rated this" };
    await tx
      .update(participants)
      .set({ firstResponseAt: sql`coalesce(${participants.firstResponseAt}, now())` })
      .where(eq(participants.id, participantId));
    return { eventId: interaction.eventId, scale, value: rawValue };
  });

  if (outcome.error) return { ok: false, status: outcome.error, error: outcome.message };
  const results = await computeResults(getDb(), interactionId, outcome.scale);
  publish(outcome.eventId, "rating:results", { results });
  return { ok: true, value: outcome.value, results };
}

export type RatingReadResult =
  | { ok: true; results: RatingResults; mine: number | null }
  | { ok: false; status: 404; error: string };

const notFound = { ok: false, status: 404, error: "Interaction not found" } as const;

/** Aggregates for a joined participant, with their own rating. Draft interactions look missing. */
export async function getResultsForParticipant(interactionId: string, participantId: string): Promise<RatingReadResult> {
  const db = getDb();
  const [interaction] = await db.select().from(interactions).where(eq(interactions.id, interactionId));
  if (!interaction || interaction.type !== "rating" || interaction.state === "draft") return notFound;
  const [participant] = await db
    .select({ id: participants.id })
    .from(participants)
    .where(and(eq(participants.id, participantId), eq(participants.eventId, interaction.eventId)));
  if (!participant) return notFound;
  const [mine] = await db
    .select({ value: ratingResponses.value })
    .from(ratingResponses)
    .where(and(eq(ratingResponses.interactionId, interactionId), eq(ratingResponses.participantId, participantId)));
  return { ok: true, results: await computeResults(db, interactionId, scaleOf(interaction.config)), mine: mine?.value ?? null };
}

/** Aggregates for the owning host, any state. */
export async function getResultsForHost(interactionId: string, ownerId: string): Promise<RatingReadResult> {
  const db = getDb();
  const [row] = await db
    .select({ interaction: interactions })
    .from(interactions)
    .innerJoin(events, eq(events.id, interactions.eventId))
    .where(and(eq(interactions.id, interactionId), eq(events.ownerId, ownerId)));
  if (!row || row.interaction.type !== "rating") return notFound;
  return { ok: true, results: await computeResults(db, interactionId, scaleOf(row.interaction.config)), mine: null };
}

/** Aggregates for the presenter screen. */
export async function getPresenterResults(interactionId: string, config: unknown): Promise<RatingResults> {
  return computeResults(getDb(), interactionId, scaleOf(config));
}
