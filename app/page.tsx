import Link from "next/link";
import { JoinForm } from "@/components/join-form";
import { getT } from "@/lib/i18n/server";

export default async function Home() {
  const t = await getT();
  return (
    <main id="main" className="entry-page">
      <h1>{t("home.title")}</h1>
      <p className="entry-lead">{t("home.lead")}</p>
      <JoinForm />
      <p className="entry-alt">
        {t("home.hostPrompt")} <Link href="/signup">{t("home.createAccount")}</Link> {t("home.or")} <Link href="/login">{t("home.logIn")}</Link>.
      </p>
      <p className="entry-alt">
        <Link href="/pricing">{t("home.pricing")}</Link>
      </p>
    </main>
  );
}
