import type { MessageKey, TParams } from "@/lib/i18n";
import { randomInt } from "node:crypto";
import { LOCALES, type Locale } from "@/lib/i18n/locale";

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

type Parsed<T> = { ok: true; value: T } | { ok: false; error: MessageKey; params?: TParams };

export type EventInput = {
  name?: string;
  startsAt?: Date;
  endsAt?: Date;
  moderationMode?: ModerationMode;
  audienceLocale?: Locale;
};

function parseDate(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Validates an event body. With `partial`, absent fields are skipped (PATCH). */
export function parseEventInput(body: unknown, partial: boolean): Parsed<EventInput> {
  if (!body || typeof body !== "object") return { ok: false, error: "api.invalidBody" };
  const b = body as Record<string, unknown>;
  const value: EventInput = {};

  if (!partial || b.name !== undefined) {
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name) return { ok: false, error: "api.eventNameRequired" };
    if (name.length > EVENT_NAME_MAX) {
      return { ok: false, error: "api.eventNameMax", params: { max: EVENT_NAME_MAX } };
    }
    value.name = name;
  }
  for (const [key, label] of [["startsAt", "api.startDateInvalid"], ["endsAt", "api.endDateInvalid"]] as const) {
    if (!partial || b[key] !== undefined) {
      const date = parseDate(b[key]);
      if (!date) return { ok: false, error: label };
      value[key] = date;
    }
  }
  if (b.moderationMode !== undefined) {
    if (!MODERATION_MODES.includes(b.moderationMode as ModerationMode)) {
      return { ok: false, error: "api.moderationModeInvalid" };
    }
    value.moderationMode = b.moderationMode as ModerationMode;
  }
  if (b.audienceLocale !== undefined) {
    // Exact codes only: this is a stored setting, not an Accept-Language guess.
    const locale = LOCALES.find((l) => l === b.audienceLocale);
    if (!locale) return { ok: false, error: "api.audienceLocaleInvalid" };
    value.audienceLocale = locale;
  }
  if (value.startsAt && value.endsAt && value.endsAt < value.startsAt) {
    return { ok: false, error: "api.endBeforeStart" };
  }
  return { ok: true, value };
}
