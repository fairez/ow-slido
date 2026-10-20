"use client";

import { createContext, useCallback, useContext, type ReactNode } from "react";
import { DEFAULT_LOCALE, t, type Locale, type MessageKey, type TParams } from "./index";

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

export function useT() {
  const locale = useContext(LocaleContext);
  return useCallback((key: MessageKey, params?: TParams) => t(locale, key, params), [locale]);
}
