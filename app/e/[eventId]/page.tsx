import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { events } from "@/db/schema";
import { getDb } from "@/lib/db";
import { EventUnavailable } from "@/components/event-unavailable";
import { AudienceLanguage } from "@/components/audience-language";
import { BrandStyle, brandAttrs } from "@/components/brand-style";
import { eventAccent } from "@/lib/branding";
import { eventUnavailable } from "@/lib/workspace-suspension";
import { ParticipantView } from "@/components/participant-view";
import { isUuid } from "@/lib/events";
import { getLiveInteraction } from "@/lib/live-view";
import { getParticipantQa } from "@/lib/questions";
import { participantCookieName, verifyParticipantToken } from "@/lib/participant-token";

export const dynamic = "force-dynamic";

export default async function ParticipantPage({
  params,
  searchParams,
}: {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<{ j?: string }>;
}) {
  const { eventId } = await params;
  if (!isUuid(eventId)) notFound();
  const [event] = await getDb().select().from(events).where(eq(events.id, eventId));
  if (!event) notFound();
  if (await eventUnavailable(event.id)) {
    return (
      <main id="main" className="participant">
        <EventUnavailable />
      </main>
    );
  }

  const token = (await cookies()).get(participantCookieName(event.id))?.value;
  const participantId = token ? verifyParticipantToken(token, event.id) : null;
  if (!participantId) {
    // Coming straight from a successful join (`j`) without a cookie means the browser dropped it.
    // Sending the participant back to join again would loop forever, so explain instead.
    const { j } = await searchParams;
    redirect(`/join/${event.joinCode}${j ? "?cookies=blocked" : ""}`);
  }

  const accent = await eventAccent(event.id);
  return (
    <main id="main" className="participant" {...brandAttrs(accent)}>
      <BrandStyle accent={accent} />
      <h1>{event.name}</h1>
      <ParticipantView
        eventId={event.id}
        initial={await getLiveInteraction(event.id, participantId)}
        initialQa={await getParticipantQa(event.id, participantId)}
      />
      <AudienceLanguage eventId={event.id} />
    </main>
  );
}
