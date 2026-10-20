import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ModerationPanel } from "@/components/moderation-panel";
import { can } from "@/lib/auth/permissions";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { redirectIfTwoFactorMissing } from "@/lib/auth/two-factor-policy";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { WORKSPACE_COOKIE, resolveActiveMembership } from "@/lib/auth/workspace";
import { isUuid } from "@/lib/events";
import { getT } from "@/lib/i18n/server";
import { listHostNotes, listHostQuestions } from "@/lib/moderation";
import { readQaConfig, resolveEventQa } from "@/lib/questions";
import { and, asc, eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
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
  await redirectIfTwoFactorMissing(membership.workspaceId, user.id);
  const event = await findOwnedEvent(id, membership.workspaceId);
  if (!event) notFound();

  const qas = (
    await getDb()
      .select()
      .from(interactions)
      .where(and(eq(interactions.eventId, event.id), eq(interactions.type, "qa")))
      .orderBy(asc(interactions.position), asc(interactions.createdAt))
  ).map((row) => ({ id: row.id, title: row.title, state: row.state, moderation: readQaConfig(row.config).moderation }));
  const initialQaId = await resolveEventQa(getDb(), event.id);

  return (
    <main id="main" className="page">
      <Link href={`/dashboard/events/${event.id}`} className="back-link">{t("dash.backToEvent")}</Link>
      <header className="page-head">
        <h1>{t("moderatePage.heading", { name: event.name })}</h1>
      </header>
      <ModerationPanel
        eventId={event.id}
        qas={qas}
        initialQaId={initialQaId}
        initialQuestions={initialQaId ? await listHostQuestions(initialQaId) : []}
        initialNotes={await listHostNotes(event.id)}
        canChangeMode={can(membership.role, "event.edit")}
      />
    </main>
  );
}
