import Link from "next/link";
import { verifyEmailToken } from "@/lib/auth/verification";
import { getDb } from "@/lib/db";
import { getT } from "@/lib/i18n/server";

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const t = await getT();
  const { token } = await searchParams;
  const ok = token ? await verifyEmailToken(getDb(), token) : false;
  return (
    <main id="main" className="entry-page">
      <h1>{ok ? t("verify.successTitle") : t("verify.failTitle")}</h1>
      <p className="entry-lead">{ok ? t("verify.successBody") : t("verify.failBody")}</p>
      <Link href={ok ? "/dashboard" : "/login"} className="ui-button" data-variant="primary">
        {ok ? t("verify.toDashboard") : t("verify.toLogin")}
      </Link>
    </main>
  );
}
