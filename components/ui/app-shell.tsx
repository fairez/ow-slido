import Link from "next/link";
import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { getT } from "@/lib/i18n/server";

export async function AppShell({ children }: { children: ReactNode }) {
  const t = await getT();
  return (
    <>
      <a className="skip-link" href="#main">
        {t("shell.skip")}
      </a>
      <header className="site-header">
        <Link className="site-name" href="/">
          {t("shell.brand")}
        </Link>
        <nav aria-label={t("shell.navLabel")} className="site-nav">
          <Link href="/dashboard">{t("shell.events")}</Link>
          <Link href="/">{t("shell.join")}</Link>
        </nav>
        <ThemeToggle />
      </header>
      {children}
    </>
  );
}
