export type Locale = "en" | "id";

export const LOCALES: readonly Locale[] = ["en", "id"];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "lang";

function asLocale(value: string | null | undefined): Locale | null {
  const base = value?.trim().toLowerCase().split("-")[0];
  return LOCALES.find((l) => l === base) ?? null;
}

// Cookie wins, then the first supported Accept-Language entry by q-value, then English.
export function resolveLocale(cookie?: string | null, acceptLanguage?: string | null): Locale {
  const fromCookie = asLocale(cookie);
  if (fromCookie) return fromCookie;
  if (acceptLanguage) {
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
  }
  return DEFAULT_LOCALE;
}
