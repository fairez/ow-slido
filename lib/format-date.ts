/** A UTC calendar day in the UI language, e.g. "20 Okt 2026" or "Oct 20, 2026". */
export function formatDay(value: Date | string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value));
}

/** A moment in the UI language and the viewer's own time zone. Client-only: the zone differs from the server's. */
export function formatMoment(value: Date | string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
