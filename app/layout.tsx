import type { ReactNode } from "react";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/public-sans";
import "./globals.css";
import { AppShell } from "@/components/ui/app-shell";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

export const metadata = { title: "OW Slido" };

export const viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
