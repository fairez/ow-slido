import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { Badge } from "@/components/ui/card";
import { PlanHint } from "@/components/plan-hint";
import { PollManager, type InteractionItem } from "@/components/poll-manager";
import { can } from "@/lib/auth/permissions";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { WORKSPACE_COOKIE, resolveActiveMembership } from "@/lib/auth/workspace";
import { responseCounts } from "@/lib/content-library";
import { isAiConfigured } from "@/lib/ai";
import { getDb } from "@/lib/db";
import { combineOverLimit, overLimitEvents } from "@/lib/over-limit";
import { aiLock, lockedFormats, lockedTypes } from "@/lib/plan-hints";
import { getEntitlements, type PlanId } from "@/lib/plans";
import { findOwnedEvent } from "@/lib/polls";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const t = await getT();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const user = await getUserFromToken(token);
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/account/password");
  const membership = resolveActiveMembership(user.memberships, (await cookies()).get(WORKSPACE_COOKIE)?.value);
  if (!membership) notFound();

  const event = await findOwnedEvent((await params).id, membership.workspaceId);
  if (!event) notFound();

  const canModerate = can(membership.role, "moderate");
  const { limits } = await getEntitlements(membership.workspaceId);
  const formatLocks = lockedFormats(limits);

  const list = await getDb()
    .select()
    .from(interactions)
    .where(eq(interactions.eventId, event.id))
    .orderBy(asc(interactions.position), asc(interactions.createdAt));

  // After a downgrade, content the plan no longer covers stays here as read-only.
  const typeLocks = lockedTypes(limits);
  const eventLock = (await overLimitEvents(membership.workspaceId)).get(event.id) ?? null;
  const itemLocks: Record<string, { requiredPlan: PlanId | null }> = {};
  for (const item of list) {
    const lock = combineOverLimit(eventLock, typeLocks[item.type] ?? null);
    if (lock) itemLocks[item.id] = lock;
  }

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
          {canModerate && (
            <Link href={`/dashboard/events/${event.id}/moderate`} className="ui-button">
              {t("moderatePage.open")}
            </Link>
          )}
          <a href={`/api/events/${event.id}/export.csv`} download className="ui-button">
            {t("dash.exportCsv")}
          </a>
          {formatLocks.pdf && <PlanHint lock={formatLocks.pdf}>{t("dash.exportPdf")}</PlanHint>}
          {formatLocks.xlsx && <PlanHint lock={formatLocks.xlsx}>{t("dash.exportXlsx")}</PlanHint>}
        </div>
      </header>
      {eventLock && (
        <div role="status" className="notice" data-tone="locked">
          <p className="notice-title">{t("dash.eventReadOnlyTitle")}</p>
          <p>{t("dash.eventReadOnlyBody")}</p>
          <p>
            <PlanHint lock={eventLock}>{t("pollMgr.unlock")}</PlanHint>
          </p>
        </div>
      )}
      <PollManager
        eventId={event.id}
        initialInteractions={list as InteractionItem[]}
        aiEnabled={isAiConfigured()}
        lockedTypes={typeLocks}
        aiLock={aiLock(limits)}
        itemLocks={itemLocks}
        eventLock={eventLock ?? undefined}
        defaultModeration={event.moderationMode}
        initialCounts={await responseCounts(event.id)}
        liveUpdates
      />
    </main>
  );
}
