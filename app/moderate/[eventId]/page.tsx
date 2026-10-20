import { eq } from "drizzle-orm";
import { events } from "@/db/schema";
import { ModerationPanel } from "@/components/moderation-panel";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { listHostNotes, listHostQuestions } from "@/lib/moderation";
import { verifyModeratorToken } from "@/lib/moderator-token";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export default async function ModeratePage({
  params,
  searchParams,
}: {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<{ t?: string | string[] }>;
}) {
  const { eventId } = await params;
  const { t: tokenParam } = await searchParams;
  const t = await getT();
  const token = typeof tokenParam === "string" ? tokenParam : undefined;
  const valid = isUuid(eventId) && (await verifyModeratorToken(eventId, token));
  if (!valid || !token) {
    return (
      <main id="main" className="page">
        <h1>{t("moderatePage.invalidTitle")}</h1>
        <p className="row-meta">{t("moderatePage.invalidBody")}</p>
      </main>
    );
  }
  const [event] = await getDb().select().from(events).where(eq(events.id, eventId));
  return (
    <main id="main" className="page">
      <header className="page-head">
        <h1>{t("moderatePage.heading", { name: event.name })}</h1>
      </header>
      <ModerationPanel
        eventId={eventId}
        initialMode={event.moderationMode}
        initialQuestions={await listHostQuestions(eventId)}
        initialNotes={await listHostNotes(eventId)}
        moderatorToken={token}
      />
    </main>
  );
}
