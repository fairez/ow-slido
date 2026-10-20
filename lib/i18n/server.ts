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
