import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { Badge } from "@/components/ui/card";
import { ModeratorLinkManager } from "@/components/moderator-link-manager";
import { ModerationPanel } from "@/components/moderation-panel";
import { PollManager, type InteractionItem } from "@/components/poll-manager";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { WORKSPACE_COOKIE, resolveActiveMembership } from "@/lib/auth/workspace";
import { isAiConfigured } from "@/lib/ai";
import { getDb } from "@/lib/db";
import { listHostNotes, listHostQuestions } from "@/lib/moderation";
import { createModeratorToken } from "@/lib/moderator-token";
import { findOwnedEvent } from "@/lib/polls";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const t = await getT();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const user = await getUserFromToken(token);
  if (!user) redirect("/login");
  const membership = resolveActiveMembership(user.memberships, (await cookies()).get(WORKSPACE_COOKIE)?.value);
  if (!membership) notFound();

  const event = await findOwnedEvent((await params).id, membership.workspaceId);
  if (!event) notFound();

  const list = await getDb()
    .select()
    .from(interactions)
    .where(eq(interactions.eventId, event.id))
    .orderBy(asc(interactions.position), asc(interactions.createdAt));

  const hostQuestions = await listHostQuestions(event.id);
  const hostNotes = await listHostNotes(event.id);

  const moderatorLink = event.moderatorNonce
    ? `/moderate/${event.id}?t=${encodeURIComponent(createModeratorToken(event.id, event.moderatorNonce))}`
    : null;

  return (
    <main id="main" className="page">
      <Link href="/dashboard" className="back-link">{t("dash.backToEvents")}</Link>
      <header className="page-head">
        <div>
          <h1>{event.name}</h1>
          <p className="row-meta">
            {t("dash.joinCode")} <Badge>{event.joinCode}</Badge>
          </p>
        </div>
        <div className="row-actions">
          <Link href={`/present/${event.id}`} className="ui-button" data-variant="primary">
            {t("dash.openPresenter")}
          </Link>
          <a href={`/api/events/${event.id}/export.csv`} download className="ui-button">
            {t("dash.exportCsv")}
          </a>
        </div>
      </header>
      <PollManager eventId={event.id} initialInteractions={list as InteractionItem[]} aiEnabled={isAiConfigured()} />
      <ModerationPanel eventId={event.id} initialMode={event.moderationMode} initialQuestions={hostQuestions} initialNotes={hostNotes} />
      <ModeratorLinkManager eventId={event.id} initialLink={moderatorLink} />
    </main>
  );
}
