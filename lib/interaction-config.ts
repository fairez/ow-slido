import type { MessageKey, TParams } from "@/lib/i18n";
export const NEW_INTERACTION_TYPES = ["sharedNotes", "openText", "rating", "qa"] as const;
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
export type QaConfig = { prompt: string; moderation: "open" | "moderated"; profanityFilter: boolean };

export const QA_DEFAULT_TITLE = "Q&A";
export const QA_DEFAULT_PROMPT = "Ask a question";

type ConfigByType = {
  sharedNotes: SharedNotesConfig;
  openText: OpenTextConfig;
  rating: RatingConfig;
  qa: QaConfig;
};
type Parsed<T> = { ok: true; value: T } | { ok: false; error: MessageKey; params?: TParams };
type FieldError = { error: MessageKey; params?: TParams };
export type ParsedInteraction<T extends NewInteractionType> = { title?: string; config: Partial<ConfigByType[T]> };

export const isNewInteractionType = (v: unknown): v is NewInteractionType =>
  typeof v === "string" && (NEW_INTERACTION_TYPES as readonly string[]).includes(v);

const DEFAULTS: ConfigByType = {
  sharedNotes: { prompt: "", maxNotesPerParticipant: 3, moderation: "open", showAuthorNames: false },
  openText: { prompt: "", maxResponsesPerParticipant: 1 },
  rating: { prompt: "", scale: "stars5" },
  qa: { prompt: QA_DEFAULT_PROMPT, moderation: "open", profanityFilter: true },
};

function intField(
  b: Record<string, unknown>,
  key: string,
  errorKey: MessageKey,
  min: number,
  max: number,
  out: Record<string, unknown>,
): FieldError | null {
  if (b[key] === undefined) return null;
  const n = b[key];
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    return { error: errorKey, params: { min, max } };
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
  if (!body || typeof body !== "object") return { ok: false, error: "api.invalidBody" };
  const b = body as Record<string, unknown>;
  const config: Record<string, unknown> = {};
  let title: string | undefined;

  if (type === "qa") {
    // Q&A names itself: the prompt is optional and the title stays "Q&A" unless the host gives one.
    if (b.prompt !== undefined) {
      const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
      if (!prompt) return { ok: false, error: "api.promptRequired" };
      if (prompt.length > INTERACTION_PROMPT_MAX) {
        return { ok: false, error: "api.promptMax", params: { max: INTERACTION_PROMPT_MAX } };
      }
      config.prompt = prompt;
    }
    if (b.title !== undefined) {
      const name = typeof b.title === "string" ? b.title.trim() : "";
      if (!name) return { ok: false, error: "api.titleRequired" };
      if (name.length > INTERACTION_PROMPT_MAX) {
        return { ok: false, error: "api.promptMax", params: { max: INTERACTION_PROMPT_MAX } };
      }
      title = name;
    } else if (!partial) {
      title = QA_DEFAULT_TITLE;
    }
  } else if (!partial || b.prompt !== undefined) {
    const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
    if (!prompt) return { ok: false, error: "api.promptRequired" };
    if (prompt.length > INTERACTION_PROMPT_MAX) {
      return { ok: false, error: "api.promptMax", params: { max: INTERACTION_PROMPT_MAX } };
    }
    title = prompt;
    config.prompt = prompt;
  }

  let error: FieldError | null = null;
  if (type === "qa") {
    if (b.moderation !== undefined) {
      if (b.moderation !== "open" && b.moderation !== "moderated") error = { error: "api.moderationInvalid" };
      else config.moderation = b.moderation;
    }
    if (!error && b.profanityFilter !== undefined) {
      if (typeof b.profanityFilter !== "boolean") error = { error: "api.profanityFilterBoolean" };
      else config.profanityFilter = b.profanityFilter;
    }
  } else if (type === "sharedNotes") {
    error = intField(b, "maxNotesPerParticipant", "api.notesPerParticipantRange", NOTES_MIN, NOTES_MAX, config);
    if (!error && b.moderation !== undefined) {
      if (b.moderation !== "open" && b.moderation !== "moderated") error = { error: "api.moderationInvalid" };
      else config.moderation = b.moderation;
    }
    if (!error && b.showAuthorNames !== undefined) {
      if (typeof b.showAuthorNames !== "boolean") error = { error: "api.showAuthorNamesBoolean" };
      else config.showAuthorNames = b.showAuthorNames;
    }
  } else if (type === "openText") {
    error = intField(b, "maxResponsesPerParticipant", "api.responsesPerParticipantRange", OPEN_TEXT_MIN, OPEN_TEXT_MAX, config);
  } else if (b.scale !== undefined) {
    if (b.scale !== "stars5" && b.scale !== "numeric10") error = { error: "api.scaleInvalid" };
    else config.scale = b.scale;
  }
  if (error) return { ok: false, ...error };
  return { ok: true, value: { title, config: config as Partial<ConfigByType[T]> } };
}

/** Fills defaults for fields the caller left out. */
export function newInteractionConfig<T extends NewInteractionType>(
  type: T,
  partial: Partial<ConfigByType[T]>,
): ConfigByType[T] {
  return { ...DEFAULTS[type], ...partial };
}
