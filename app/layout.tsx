import type { ReactNode } from "react";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/public-sans";
import "./globals.css";
import { AppShell } from "@/components/ui/app-shell";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { I18nProvider } from "@/lib/i18n/client";
import { getLocale } from "@/lib/i18n/server";

export const metadata = { title: "OW Slido" };

export const viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <I18nProvider locale={locale}>
          <AppShell>{children}</AppShell>
        </I18nProvider>
      </body>
    </html>
  );
}
