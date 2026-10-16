import { eq } from "drizzle-orm";
import { events } from "@/db/schema";
import { ModerationPanel } from "@/components/moderation-panel";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { listHostQuestions } from "@/lib/moderation";
import { verifyModeratorToken } from "@/lib/moderator-token";

export const dynamic = "force-dynamic";

export default async function ModeratePage({
  params,
  searchParams,
}: {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<{ t?: string | string[] }>;
}) {
  const { eventId } = await params;
  const { t } = await searchParams;
  const token = typeof t === "string" ? t : undefined;
  const valid = isUuid(eventId) && (await verifyModeratorToken(eventId, token));
  if (!valid || !token) {
    return (
      <main style={{ maxWidth: 720, margin: "0 auto", padding: 16 }}>
        <h1>Moderator link not valid</h1>
        <p>This link is invalid or has been revoked. Ask the host for a new one.</p>
      </main>
    );
  }
  const [event] = await getDb().select().from(events).where(eq(events.id, eventId));
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 16 }}>
      <h1>Moderating: {event.name}</h1>
      <ModerationPanel
        eventId={eventId}
        initialMode={event.moderationMode}
        initialQuestions={await listHostQuestions(eventId)}
        moderatorToken={token}
      />
    </main>
  );
}
