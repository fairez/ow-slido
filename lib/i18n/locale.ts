export type Locale = "en" | "id";

export const LOCALES: readonly Locale[] = ["en", "id"];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "lang";

/** Narrows a stored or submitted value (`id`, `id-ID`, ` EN `) to a supported locale, else null. */
export function parseLocale(value: unknown): Locale | null {
  return typeof value === "string" ? asLocale(value) : null;
}

function asLocale(value: string | null | undefined): Locale | null {
  const base = value?.trim().toLowerCase().split("-")[0];
  return LOCALES.find((l) => l === base) ?? null;
}

function fromAcceptLanguage(acceptLanguage?: string | null): Locale | null {
  if (!acceptLanguage) return null;
  const ranked = acceptLanguage
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag, weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((e) => e.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const entry of ranked) {
    const found = asLocale(entry.tag);
    if (found) return found;
  }
  return null;
}

export type LocaleSources = {
  /** What a participant picked for this event (the per-event cookie). */
  participantChoice?: string | null;
  /** The event's audience language. */
  eventAudience?: string | null;
  /** The host's setting: the `lang` cookie, which login fills from `users.locale`. */
  hostSetting?: string | null;
  acceptLanguage?: string | null;
};

/**
 * First supported value wins: the participant's own choice for the event, the event's audience language, the
 * host's setting, the browser's Accept-Language, English. Audience pages pass the first two (an event always has
 * an audience language, so the rest is a fallback there); host pages pass only the last two.
 */
export function resolveLocaleFrom(sources: LocaleSources): Locale {
  return (
    asLocale(sources.participantChoice) ??
    asLocale(sources.eventAudience) ??
    asLocale(sources.hostSetting) ??
    fromAcceptLanguage(sources.acceptLanguage) ??
    DEFAULT_LOCALE
  );
}

// Cookie wins, then the first supported Accept-Language entry by q-value, then English.
export function resolveLocale(cookie?: string | null, acceptLanguage?: string | null): Locale {
  return resolveLocaleFrom({ hostSetting: cookie, acceptLanguage });
}

/** A participant's language choice for one event; unlike `lang` it is readable by scripts and by the page. */
export const audienceLocaleCookie = (eventId: string) => `lang_${eventId}`;

const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;

/** Browser only: remembers the participant's language for one event. */
export function storeAudienceLocale(eventId: string, locale: Locale) {
  document.cookie = `${audienceLocaleCookie(eventId)}=${locale}; Path=/; Max-Age=${THIRTY_DAYS_SECONDS}; SameSite=Lax`;
}

export type AudienceTarget = { kind: "join" | "event" | "present" | "survey"; key: string };

/** Which audience page a path is, and the id or code in it. Anything else is a host or account page. */
export function audienceTarget(pathname: string): AudienceTarget | null {
  const match = /^\/(join|e|present|survey)\/([^/?#]+)/.exec(pathname);
  if (!match) return null;
  const kind = match[1] === "e" ? "event" : (match[1] as AudienceTarget["kind"]);
  try {
    return { kind, key: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}
