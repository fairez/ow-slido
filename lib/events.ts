import { randomInt } from "node:crypto";

export const EVENT_NAME_MAX = 80;
export const MODERATION_MODES = ["open", "moderated"] as const;
export type ModerationMode = (typeof MODERATION_MODES)[number];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string) {
  return UUID_PATTERN.test(value);
}

export function randomJoinCode() {
  return String(randomInt(100000, 1000000));
}

/** Picks codes until `isFree` accepts one; the DB unique index remains the final guard. */
export async function generateUniqueJoinCode(
  isFree: (code: string) => Promise<boolean>,
  next: () => string = randomJoinCode,
  attempts = 10,
) {
  for (let i = 0; i < attempts; i++) {
    const code = next();
    if (await isFree(code)) return code;
  }
  throw new Error("Could not generate a unique join code");
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export type EventInput = {
  name?: string;
  startsAt?: Date;
  endsAt?: Date;
  moderationMode?: ModerationMode;
};

function parseDate(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Validates an event body. With `partial`, absent fields are skipped (PATCH). */
export function parseEventInput(body: unknown, partial: boolean): Parsed<EventInput> {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid request body" };
  const b = body as Record<string, unknown>;
  const value: EventInput = {};

  if (!partial || b.name !== undefined) {
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name) return { ok: false, error: "Event name is required" };
    if (name.length > EVENT_NAME_MAX) {
      return { ok: false, error: `Event name must be at most ${EVENT_NAME_MAX} characters` };
    }
    value.name = name;
  }
  for (const [key, label] of [["startsAt", "Start"], ["endsAt", "End"]] as const) {
    if (!partial || b[key] !== undefined) {
      const date = parseDate(b[key]);
      if (!date) return { ok: false, error: `${label} date is required and must be a valid date` };
      value[key] = date;
    }
  }
  if (b.moderationMode !== undefined) {
    if (!MODERATION_MODES.includes(b.moderationMode as ModerationMode)) {
      return { ok: false, error: "Moderation mode must be 'open' or 'moderated'" };
    }
    value.moderationMode = b.moderationMode as ModerationMode;
  }
  if (value.startsAt && value.endsAt && value.endsAt < value.startsAt) {
    return { ok: false, error: "End date cannot be before the start date" };
  }
  return { ok: true, value };
}
