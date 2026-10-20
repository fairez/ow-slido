import { en, type MessageKey } from "./en";
import { id } from "./id";
import type { Locale } from "./locale";

export type { MessageKey } from "./en";
export { DEFAULT_LOCALE, LOCALES, LOCALE_COOKIE, parseLocale, resolveLocale, resolveLocaleFrom, type Locale } from "./locale";

const MESSAGES: Record<Locale, Record<MessageKey, string>> = { en, id };

export type TParams = Record<string, string | number>;

export function t(locale: Locale, key: MessageKey, params?: TParams): string {
  const message = MESSAGES[locale][key];
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}
