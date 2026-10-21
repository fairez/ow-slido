"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n/client";

/** Terms and Privacy links for screens that have no site footer: sign-up and the join and participant screens. */
export function LegalLinks() {
  const t = useT();
  return (
    <nav className="legal-links" aria-label={t("legal.linksLabel")}>
      <Link href="/terms">{t("legal.terms.nav")}</Link>
      <Link href="/privacy">{t("legal.privacy.nav")}</Link>
    </nav>
  );
}
