import { LOCALE_COOKIE, resolveLocale, resolveLocaleFrom, t, type Locale, type MessageKey, type TParams } from "./index";
import { audienceLocaleCookie, audienceTarget } from "./locale";

export async function getLocale(): Promise<Locale> {
  // Loaded lazily: the custom server imports this module (through the socket auth) before Next has set up
  // its AsyncLocalStorage, and a top-level import of next/headers throws there.
  const { cookies, headers } = await import("next/headers");
  const [jar, list] = await Promise.all([cookies(), headers()]);
  const accept = list.get("accept-language");
  // Join, participant, survey and presenter pages follow the event, not the host's setting (see proxy.ts).
  const path = list.get("x-audience-path");
  const target = path ? audienceTarget(path) : null;
  if (target) {
    const { audienceEventFor } = await import("@/lib/audience-locale");
    const event = await audienceEventFor(target);
    if (event) {
      return resolveLocaleFrom({
        // The presenter shows the event to the room; a participant cookie in the host's browser must not change it.
        participantChoice: target.kind === "present" ? null : jar.get(audienceLocaleCookie(event.id))?.value,
        eventAudience: event.audienceLocale,
        acceptLanguage: accept,
      });
    }
  }
  return resolveLocale(jar.get(LOCALE_COOKIE)?.value, accept);
}

export async function getT() {
  const locale = await getLocale();
  return (key: MessageKey, params?: TParams) => t(locale, key, params);
}

function requestLocale(request: Request): Locale {
  const cookie = /(?:^|;\s*)lang=([^;]*)/.exec(request.headers.get("cookie") ?? "")?.[1];
  return resolveLocale(cookie ? decodeURIComponent(cookie) : undefined, request.headers.get("accept-language"));
}

/** Translates a message for API routes, which read the locale from the request they were handed. */
export function serverT(request: Request, key: MessageKey, params?: TParams): string {
  return t(requestLocale(request), key, params);
}

/** For results shaped `{ error: MessageKey, params? }` coming back from lib code. */
export function apiMessage(request: Request, result: { error: MessageKey; params?: TParams }): string {
  return serverT(request, result.error, result.params);
}
