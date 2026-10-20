import Link from "next/link";
import { ResetForm } from "@/components/password-forms";
import { getT } from "@/lib/i18n/server";

export default async function ResetPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  if (token) return <ResetForm token={token} />;
  const t = await getT();
  return (
    <main id="main" className="entry-page">
      <h1>{t("reset.missingTitle")}</h1>
      <p className="entry-lead">{t("reset.missingBody")}</p>
      <Link href="/forgot" className="ui-button" data-variant="primary">
        {t("reset.requestNew")}
      </Link>
    </main>
  );
}
