import Link from "next/link";
import { getT } from "@/lib/i18n/server";

export default async function NotFound() {
  const t = await getT();
  return (
    <main id="main" className="page">
      <h1>{t("notFound.title")}</h1>
      <p className="row-meta">{t("notFound.body")}</p>
      <Link href="/login" className="ui-button" data-variant="primary">
        {t("notFound.logIn")}
      </Link>
    </main>
  );
}
