import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { ModeratorLinkManager } from "@/components/moderator-link-manager";
import { ModerationPanel } from "@/components/moderation-panel";
import { PollManager, type InteractionItem } from "@/components/poll-manager";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { isAiConfigured } from "@/lib/ai";
import { getDb } from "@/lib/db";
import { listHostNotes, listHostQuestions } from "@/lib/moderation";
import { createModeratorToken } from "@/lib/moderator-token";
import { findOwnedEvent } from "@/lib/polls";

export const dynamic = "force-dynamic";

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const user = await getUserFromToken(token);
  if (!user) redirect("/login");

  const event = await findOwnedEvent((await params).id, user.id);
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
      <Link href="/dashboard">← Dashboard</Link>
      <h1>{event.name}</h1>
      <p>
        Join code: <strong>{event.joinCode}</strong>
      </p>
      <p>
        <Link href={`/present/${event.id}`}>Open presenter view</Link>
      </p>
      <p>
        <a href={`/api/events/${event.id}/export.csv`} download>
          Export CSV
        </a>
      </p>
      <PollManager eventId={event.id} initialInteractions={list as InteractionItem[]} aiEnabled={isAiConfigured()} />
      <ModerationPanel eventId={event.id} initialMode={event.moderationMode} initialQuestions={hostQuestions} initialNotes={hostNotes} />
      <ModeratorLinkManager eventId={event.id} initialLink={moderatorLink} />
    </main>
  );
}
