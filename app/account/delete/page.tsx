import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DeleteAccount } from "@/components/delete-account";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export default async function DeleteAccountPage() {
  const t = await getT();
  const user = await getUserFromToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/account/password");

  return (
    <main id="main" className="page security-page">
      <Link href="/account/security" className="back-link">
        {t("account.delete.back")}
      </Link>
      <h1>{t("account.delete.title")}</h1>
      <p className="entry-lead">{t("account.delete.lead")}</p>
      <ul className="delete-account-effects">
        <li>{t("account.delete.effectLeave")}</li>
        <li>{t("account.delete.effectSolo")}</li>
        <li>{t("account.delete.effectOwner")}</li>
      </ul>
      <DeleteAccount />
    </main>
  );
}
