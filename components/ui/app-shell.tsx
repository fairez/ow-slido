import Link from "next/link";
import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/theme-toggle";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <Link className="site-name" href="/">
          OW Slido
        </Link>
        <nav aria-label="Main" className="site-nav">
          <Link href="/dashboard">Events</Link>
          <Link href="/">Join</Link>
        </nav>
        <ThemeToggle />
      </header>
      {children}
    </>
  );
}
