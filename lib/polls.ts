import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { events, interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";

import { POLL_MAX_OPTIONS, POLL_MIN_OPTIONS, POLL_OPTION_MAX, POLL_QUESTION_MAX } from "@/lib/poll-limits";

export { POLL_MAX_OPTIONS, POLL_MIN_OPTIONS, POLL_OPTION_MAX, POLL_QUESTION_MAX };

export type PollOption = { id: string; label: string };
export type PollConfig = {
  options: PollOption[];
  multiSelect: boolean;
  showResultsToParticipants: boolean;
};
export type PollInput = { title?: string; config: Partial<PollConfig> };

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Accepts plain labels or `{id?, label}`; ids of existing options are kept, others generated. */
function parseOptions(raw: unknown): Parsed<PollOption[]> {
  if (!Array.isArray(raw)) return { ok: false, error: "Options must be a list" };
  if (raw.length < POLL_MIN_OPTIONS || raw.length > POLL_MAX_OPTIONS) {
    return {
      ok: false,
      error: `A poll needs ${POLL_MIN_OPTIONS} to ${POLL_MAX_OPTIONS} options`,
    };
  }
  const options: PollOption[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const obj = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    const labelRaw = typeof entry === "string" ? entry : obj?.label;
    const label = typeof labelRaw === "string" ? labelRaw.trim() : "";
    if (!label) return { ok: false, error: "Option labels cannot be empty" };
    if (label.length > POLL_OPTION_MAX) {
      return { ok: false, error: `Option labels must be at most ${POLL_OPTION_MAX} characters` };
    }
    let id = typeof obj?.id === "string" && obj.id ? obj.id : randomUUID();
    if (seen.has(id)) id = randomUUID();
    seen.add(id);
    options.push({ id, label });
  }
  return { ok: true, value: options };
}

/** Validates a poll body. With `partial`, absent fields are skipped (PATCH). */
export function parsePollInput(body: unknown, partial: boolean): Parsed<PollInput> {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid request body" };
  const b = body as Record<string, unknown>;
  const value: PollInput = { config: {} };

  if (!partial || b.question !== undefined) {
    const question = typeof b.question === "string" ? b.question.trim() : "";
    if (!question) return { ok: false, error: "Question is required" };
    if (question.length > POLL_QUESTION_MAX) {
      return { ok: false, error: `Question must be at most ${POLL_QUESTION_MAX} characters` };
    }
    value.title = question;
  }
  if (!partial || b.options !== undefined) {
    const options = parseOptions(b.options);
    if (!options.ok) return options;
    value.config.options = options.value;
  }
  for (const key of ["multiSelect", "showResultsToParticipants"] as const) {
    if (b[key] !== undefined) {
      if (typeof b[key] !== "boolean") return { ok: false, error: `${key} must be true or false` };
      value.config[key] = b[key];
    }
  }
  return { ok: true, value };
}

export function pollConfig(partial: Partial<PollConfig>): PollConfig {
  return {
    options: partial.options ?? [],
    multiSelect: partial.multiSelect ?? false,
    showResultsToParticipants: partial.showResultsToParticipants ?? false,
  };
}

export async function findOwnedEvent(id: string, ownerId: string) {
  if (!isUuid(id)) return null;
  const [event] = await getDb()
    .select()
    .from(events)
    .where(and(eq(events.id, id), eq(events.ownerId, ownerId)));
  return event ?? null;
}

export async function findInteraction(eventId: string, id: string) {
  if (!isUuid(id)) return null;
  const [row] = await getDb()
    .select()
    .from(interactions)
    .where(and(eq(interactions.id, id), eq(interactions.eventId, eventId)));
  return row ?? null;
}

export const eventNotFound = () => Response.json({ error: "Event not found" }, { status: 404 });
export const interactionNotFound = () =>
  Response.json({ error: "Interaction not found" }, { status: 404 });
