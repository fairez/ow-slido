import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { events } from "@/db/schema";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { participantCookieName, verifyParticipantToken } from "@/lib/participant-token";

export const dynamic = "force-dynamic";

export default async function ParticipantPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  if (!isUuid(eventId)) notFound();
  const [event] = await getDb().select().from(events).where(eq(events.id, eventId));
  if (!event) notFound();

  const token = (await cookies()).get(participantCookieName(event.id))?.value;
  if (!token || !verifyParticipantToken(token, event.id)) redirect(`/join/${event.joinCode}`);

  return (
    <main style={{ maxWidth: 400, margin: "0 auto", padding: 16 }}>
      <h1>{event.name}</h1>
      <p role="status">Waiting for the host to start something…</p>
    </main>
  );
}
