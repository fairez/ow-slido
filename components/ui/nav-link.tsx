"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * A header link that marks the page the visitor is on. `href` matches itself and anything below it, except
 * "/" and "/dashboard", which match only themselves; `alsoUnder` lists the sections that belong to a link
 * that cannot be matched by prefix (events live under /dashboard/events).
 */
export function NavLink({ href, alsoUnder = [], children }: { href: string; alsoUnder?: string[]; children: ReactNode }) {
  const pathname = usePathname();
  const below = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
  const current = href === "/" || href === "/dashboard" ? pathname === href || alsoUnder.some(below) : below(href);
  return (
    <Link href={href} aria-current={current ? "page" : undefined}>
      {children}
    </Link>
  );
}
