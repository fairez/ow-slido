import { cookieAttributes } from "@/lib/auth/session";
import { LOCALE_COOKIE, type Locale } from "./locale";

const YEAR_SECONDS = 60 * 60 * 24 * 365;

/** The `lang` cookie for a host; login sets it from `users.locale` so a new device follows the saved choice. */
export const localeSetCookie = (locale: Locale, secure: boolean) =>
  `${LOCALE_COOKIE}=${locale}; ${cookieAttributes(YEAR_SECONDS, secure)}`;
