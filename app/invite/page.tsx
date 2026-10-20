import { cookies } from "next/headers";
import Link from "next/link";
import { InviteAcceptForm } from "@/components/invite-accept-form";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export default async function InvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const t = await getT();
  const { token } = await searchParams;
  if (!token) {
    return (
      <main id="main" className="entry-page">
        <h1>{t("invite.page.missingTitle")}</h1>
        <p className="entry-lead">{t("invite.page.missingBody")}</p>
        <Link href="/login" className="ui-button" data-variant="secondary">
          {t("invite.page.login")}
        </Link>
      </main>
    );
  }
  const user = await getUserFromToken((await cookies()).get(SESSION_COOKIE)?.value);
  return <InviteAcceptForm token={token} signedInEmail={user?.email ?? null} />;
}
