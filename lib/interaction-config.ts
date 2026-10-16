export const NEW_INTERACTION_TYPES = ["sharedNotes", "openText", "rating"] as const;
export type NewInteractionType = (typeof NEW_INTERACTION_TYPES)[number];

export const INTERACTION_PROMPT_MAX = 200;
export const NOTES_MIN = 1;
export const NOTES_MAX = 1000;
export const OPEN_TEXT_MIN = 1;
export const OPEN_TEXT_MAX = 3;

export type SharedNotesConfig = {
  prompt: string;
  maxNotesPerParticipant: number;
  moderation: "open" | "moderated";
  showAuthorNames: boolean;
};
export type OpenTextConfig = { prompt: string; maxResponsesPerParticipant: number };
export type RatingConfig = { prompt: string; scale: "stars5" | "numeric10" };

type ConfigByType = {
  sharedNotes: SharedNotesConfig;
  openText: OpenTextConfig;
  rating: RatingConfig;
};
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
export type ParsedInteraction<T extends NewInteractionType> = { title?: string; config: Partial<ConfigByType[T]> };

export const isNewInteractionType = (v: unknown): v is NewInteractionType =>
  typeof v === "string" && (NEW_INTERACTION_TYPES as readonly string[]).includes(v);

const DEFAULTS: ConfigByType = {
  sharedNotes: { prompt: "", maxNotesPerParticipant: 3, moderation: "open", showAuthorNames: false },
  openText: { prompt: "", maxResponsesPerParticipant: 1 },
  rating: { prompt: "", scale: "stars5" },
};

function intField(b: Record<string, unknown>, key: string, label: string, min: number, max: number, out: Record<string, unknown>) {
  if (b[key] === undefined) return null;
  const n = b[key];
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    return `${label} must be a whole number from ${min} to ${max}`;
  }
  out[key] = n;
  return null;
}

/** Validates a body for a new interaction type. With `partial`, absent fields are skipped (PATCH). */
export function parseNewInteractionInput<T extends NewInteractionType>(
  type: T,
  body: unknown,
  partial: boolean,
): Parsed<ParsedInteraction<T>> {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid request body" };
  const b = body as Record<string, unknown>;
  const config: Record<string, unknown> = {};
  let title: string | undefined;

  if (!partial || b.prompt !== undefined) {
    const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
    if (!prompt) return { ok: false, error: "Prompt is required" };
    if (prompt.length > INTERACTION_PROMPT_MAX) {
      return { ok: false, error: `Prompt must be at most ${INTERACTION_PROMPT_MAX} characters` };
    }
    title = prompt;
    config.prompt = prompt;
  }

  let error: string | null = null;
  if (type === "sharedNotes") {
    error = intField(b, "maxNotesPerParticipant", "Notes per participant", NOTES_MIN, NOTES_MAX, config);
    if (!error && b.moderation !== undefined) {
      if (b.moderation !== "open" && b.moderation !== "moderated") error = "Moderation must be 'open' or 'moderated'";
      else config.moderation = b.moderation;
    }
    if (!error && b.showAuthorNames !== undefined) {
      if (typeof b.showAuthorNames !== "boolean") error = "showAuthorNames must be true or false";
      else config.showAuthorNames = b.showAuthorNames;
    }
  } else if (type === "openText") {
    error = intField(b, "maxResponsesPerParticipant", "Responses per participant", OPEN_TEXT_MIN, OPEN_TEXT_MAX, config);
  } else if (b.scale !== undefined) {
    if (b.scale !== "stars5" && b.scale !== "numeric10") error = "Scale must be 'stars5' or 'numeric10'";
    else config.scale = b.scale;
  }
  if (error) return { ok: false, error };
  return { ok: true, value: { title, config: config as Partial<ConfigByType[T]> } };
}

/** Fills defaults for fields the caller left out. */
export function newInteractionConfig<T extends NewInteractionType>(
  type: T,
  partial: Partial<ConfigByType[T]>,
): ConfigByType[T] {
  return { ...DEFAULTS[type], ...partial };
}
