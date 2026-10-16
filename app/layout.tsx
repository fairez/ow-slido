import type { ReactNode } from "react";
import Link from "next/link";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/public-sans";
import "./globals.css";
import { ThemeToggle } from "@/components/theme-toggle";
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
        <header className="site-header">
          <Link href="/">OW Slido</Link>
          <ThemeToggle />
        </header>
        {children}
      </body>
    </html>
  );
}
