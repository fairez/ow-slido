import type { MessageKey, TParams } from "@/lib/i18n";
import { and, desc, eq, sql } from "drizzle-orm";
import { events, interactions, openTextResponses, participants } from "@/db/schema";
import { getDb } from "@/lib/db";
import type { OpenTextConfig } from "@/lib/interaction-config";
import { OPEN_TEXT_RESPONSE_MAX } from "@/lib/open-text-limits";
import { isProfane } from "@/lib/profanity";
import { publish } from "@/lib/realtime/publisher";

export { OPEN_TEXT_RESPONSE_MAX };

/** What participants and the presenter may see; never the participant id. */
export type PublicResponse = {
  id: string;
  interactionId: string;
  text: string;
  highlighted: boolean;
  createdAt: string;
};
export type HostResponse = PublicResponse & { hidden: boolean };

export type SubmitResult =
  | { ok: true; response: PublicResponse }
  | { ok: false; status: 400 | 404 | 409; error: MessageKey; params?: TParams };

const toPublic = (row: typeof openTextResponses.$inferSelect): PublicResponse => ({
  id: row.id,
  interactionId: row.interactionId,
  text: row.text,
  highlighted: row.highlighted,
  createdAt: row.createdAt.toISOString(),
});

const maxResponses = (config: unknown) =>
  ((config ?? {}) as Partial<OpenTextConfig>).maxResponsesPerParticipant ?? 1;

export async function submitResponse(
  interactionId: string,
  participantId: string,
  rawText: unknown,
): Promise<SubmitResult> {
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (!text) return { ok: false, status: 400, error: "api.writeFirst" };
  if (text.length > OPEN_TEXT_RESPONSE_MAX) {
    return { ok: false, status: 400, error: "api.responsesMax", params: { max: OPEN_TEXT_RESPONSE_MAX } };
  }
  if (isProfane(text)) return { ok: false, status: 400, error: "api.profaneResponse" };

  const outcome = await getDb().transaction(async (tx) => {
    // Share lock: closing (an UPDATE) waits for in-flight writes.
    const [interaction] = await tx.select().from(interactions).where(eq(interactions.id, interactionId)).for("share");
    if (!interaction || interaction.type !== "openText") return { error: 404 as const };
    // Row lock serialises one participant's writes so the limit can't be raced.
    const [participant] = await tx
      .select({ eventId: participants.eventId })
      .from(participants)
      .where(eq(participants.id, participantId))
      .for("update");
    if (!participant || participant.eventId !== interaction.eventId) return { error: 404 as const };
    if (interaction.state !== "live") return { error: 409 as const, message: "api.questionNotOpen" as const };

    const [{ used }] = await tx
      .select({ used: sql<number>`count(*)::int` })
      .from(openTextResponses)
      .where(and(eq(openTextResponses.interactionId, interactionId), eq(openTextResponses.participantId, participantId)));
    if (used >= maxResponses(interaction.config)) {
      return { error: 409 as const, message: "api.responsesUsed" as const };
    }
    const [row] = await tx.insert(openTextResponses).values({ interactionId, participantId, text }).returning();
    await tx
      .update(participants)
      .set({ firstResponseAt: sql`coalesce(${participants.firstResponseAt}, now())` })
      .where(eq(participants.id, participantId));
    return { row, eventId: interaction.eventId };
  });

  if ("error" in outcome) {
    return outcome.error === 404
      ? { ok: false, status: 404, error: "api.interactionNotFound" }
      : { ok: false, status: 409, error: outcome.message! };
  }
  const response = toPublic(outcome.row);
  publish(outcome.eventId, "response:added", { response });
  return { ok: true, response };
}

export type ListResult<T> = { ok: true; responses: T[] } | { ok: false; status: 404; error: MessageKey; params?: TParams };

async function listFor(interactionId: string, includeHidden: boolean) {
  const rows = await getDb()
    .select()
    .from(openTextResponses)
    .where(
      includeHidden
        ? eq(openTextResponses.interactionId, interactionId)
        : and(eq(openTextResponses.interactionId, interactionId), eq(openTextResponses.hidden, false)),
    )
    .orderBy(desc(openTextResponses.createdAt), desc(openTextResponses.id));
  return rows;
}

/** Visible responses, newest first. Draft interactions look like they don't exist. */
export async function listResponses(interactionId: string, participantId: string): Promise<ListResult<PublicResponse>> {
  const db = getDb();
  const [interaction] = await db
    .select({ type: interactions.type, state: interactions.state, eventId: interactions.eventId })
    .from(interactions)
    .where(eq(interactions.id, interactionId));
  if (!interaction || interaction.type !== "openText" || interaction.state === "draft") {
    return { ok: false, status: 404, error: "api.interactionNotFound" };
  }
  const [participant] = await db
    .select({ id: participants.id })
    .from(participants)
    .where(and(eq(participants.id, participantId), eq(participants.eventId, interaction.eventId)));
  if (!participant) return { ok: false, status: 404, error: "api.interactionNotFound" };
  return { ok: true, responses: (await listFor(interactionId, false)).map(toPublic) };
}

/** Every response including hidden ones, for the owning host. */
export async function listResponsesForHost(
  interactionId: string,
  ownerId: string,
): Promise<ListResult<HostResponse>> {
  const [row] = await getDb()
    .select({ type: interactions.type })
    .from(interactions)
    .innerJoin(events, eq(events.id, interactions.eventId))
    .where(and(eq(interactions.id, interactionId), eq(events.ownerId, ownerId)));
  if (!row || row.type !== "openText") return { ok: false, status: 404, error: "api.interactionNotFound" };
  const rows = await listFor(interactionId, true);
  return { ok: true, responses: rows.map((r) => ({ ...toPublic(r), hidden: r.hidden })) };
}

/** Approved-for-audience responses for the presenter screen, newest first. */
export async function listPresenterResponses(interactionId: string): Promise<PublicResponse[]> {
  return (await listFor(interactionId, false)).map(toPublic);
}

async function findOwned(responseId: string, ownerId: string) {
  const [row] = await getDb()
    .select({ response: openTextResponses, eventId: interactions.eventId })
    .from(openTextResponses)
    .innerJoin(interactions, eq(interactions.id, openTextResponses.interactionId))
    .innerJoin(events, eq(events.id, interactions.eventId))
    .where(and(eq(openTextResponses.id, responseId), eq(events.ownerId, ownerId)));
  return row ?? null;
}

export type HostChangeResult =
  | { ok: true; response: HostResponse }
  | { ok: false; status: 400 | 404; error: MessageKey; params?: TParams };

/** Owner only: toggle `highlighted` and/or `hidden`. Hiding also removes the highlight. */
export async function updateResponseAsHost(
  responseId: string,
  ownerId: string,
  change: Record<string, unknown>,
): Promise<HostChangeResult> {
  const patch: { hidden?: boolean; highlighted?: boolean } = {};
  for (const key of ["hidden", "highlighted"] as const) {
    if (change[key] === undefined) continue;
    if (typeof change[key] !== "boolean") return { ok: false, status: 400, error: "api.fieldBoolean", params: { field: key } };
    patch[key] = change[key];
  }
  if (Object.keys(patch).length === 0) return { ok: false, status: 400, error: "api.nothingToChange" };

  const found = await findOwned(responseId, ownerId);
  if (!found) return { ok: false, status: 404, error: "api.responseNotFound" };
  if (patch.hidden) patch.highlighted = false;
  const [row] = await getDb()
    .update(openTextResponses)
    .set(patch)
    .where(eq(openTextResponses.id, responseId))
    .returning();
  if (!row) return { ok: false, status: 404, error: "api.responseNotFound" };

  if (row.hidden) {
    publish(found.eventId, "response:removed", { interactionId: row.interactionId, responseId });
  } else if (found.response.hidden) {
    publish(found.eventId, "response:added", { response: toPublic(row) });
  } else {
    publish(found.eventId, "response:updated", { response: toPublic(row) });
  }
  return { ok: true, response: { ...toPublic(row), hidden: row.hidden } };
}

export async function deleteResponseAsHost(responseId: string, ownerId: string): Promise<boolean> {
  const found = await findOwned(responseId, ownerId);
  if (!found) return false;
  const [row] = await getDb()
    .delete(openTextResponses)
    .where(eq(openTextResponses.id, responseId))
    .returning({ interactionId: openTextResponses.interactionId });
  if (!row) return false;
  publish(found.eventId, "response:removed", { interactionId: row.interactionId, responseId });
  return true;
}
