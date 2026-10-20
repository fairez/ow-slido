import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ModerationPanel } from "@/components/moderation-panel";
import { can } from "@/lib/auth/permissions";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { WORKSPACE_COOKIE, resolveActiveMembership } from "@/lib/auth/workspace";
import { isUuid } from "@/lib/events";
import { getT } from "@/lib/i18n/server";
import { listHostNotes, listHostQuestions } from "@/lib/moderation";
import { findOwnedEvent } from "@/lib/polls";

export const dynamic = "force-dynamic";

export default async function ModeratePage({ params }: { params: Promise<{ id: string }> }) {
  const t = await getT();
  const jar = await cookies();
  const user = await getUserFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/account/password");
  const membership = resolveActiveMembership(user.memberships, jar.get(WORKSPACE_COOKIE)?.value);
  const { id } = await params;
  if (!membership || !can(membership.role, "moderate") || !isUuid(id)) notFound();
  const event = await findOwnedEvent(id, membership.workspaceId);
  if (!event) notFound();

  return (
    <main id="main" className="page">
      <Link href={`/dashboard/events/${event.id}`} className="back-link">{t("dash.backToEvent")}</Link>
      <header className="page-head">
        <h1>{t("moderatePage.heading", { name: event.name })}</h1>
      </header>
      <ModerationPanel
        eventId={event.id}
        initialMode={event.moderationMode}
        initialQuestions={await listHostQuestions(event.id)}
        initialNotes={await listHostNotes(event.id)}
        canChangeMode={can(membership.role, "event.edit")}
      />
    </main>
  );
}
