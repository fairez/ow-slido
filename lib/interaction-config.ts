import { randomUUID } from "node:crypto";
import type { MessageKey, TParams } from "@/lib/i18n";
import { RANKING_MAX_OPTIONS, RANKING_MIN_OPTIONS, RANKING_OPTION_MAX } from "@/lib/ranking-limits";
export const NEW_INTERACTION_TYPES = ["sharedNotes", "openText", "rating", "qa", "ranking"] as const;
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
export type RankingOption = { id: string; text: string };
export type RankingConfig = { prompt: string; options: RankingOption[] };
export type QaConfig = { prompt: string; moderation: "open" | "moderated"; profanityFilter: boolean };

export const QA_DEFAULT_TITLE = "Q&A";
export const QA_DEFAULT_PROMPT = "Ask a question";

type ConfigByType = {
  sharedNotes: SharedNotesConfig;
  openText: OpenTextConfig;
  rating: RatingConfig;
  qa: QaConfig;
  ranking: RankingConfig;
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
  ranking: { prompt: "", options: [] },
};

/** Accepts plain texts or `{id?, text}`; ids already seen are replaced so every option id is unique. */
function parseRankingOptions(raw: unknown): Parsed<RankingOption[]> {
  if (!Array.isArray(raw)) return { ok: false, error: "api.optionsList" };
  if (raw.length < RANKING_MIN_OPTIONS || raw.length > RANKING_MAX_OPTIONS) {
    return { ok: false, error: "api.rankingOptionsRange", params: { min: RANKING_MIN_OPTIONS, max: RANKING_MAX_OPTIONS } };
  }
  const options: RankingOption[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const obj = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    const textRaw = typeof entry === "string" ? entry : obj?.text;
    const text = typeof textRaw === "string" ? textRaw.trim() : "";
    if (!text) return { ok: false, error: "api.optionLabelEmpty" };
    if (text.length > RANKING_OPTION_MAX) return { ok: false, error: "api.optionLabelMax", params: { max: RANKING_OPTION_MAX } };
    let id = typeof obj?.id === "string" && obj.id ? obj.id : randomUUID();
    if (seen.has(id)) id = randomUUID();
    seen.add(id);
    options.push({ id, text });
  }
  return { ok: true, value: options };
}

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
  } else if (type === "ranking") {
    if (!partial || b.options !== undefined) {
      const options = parseRankingOptions(b.options);
      if (options.ok) config.options = options.value;
      else error = options;
    }
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
