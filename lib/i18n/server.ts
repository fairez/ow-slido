import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, resolveLocale, t, type Locale, type MessageKey, type TParams } from "./index";

export async function getLocale(): Promise<Locale> {
  const [jar, list] = await Promise.all([cookies(), headers()]);
  return resolveLocale(jar.get(LOCALE_COOKIE)?.value, list.get("accept-language"));
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
