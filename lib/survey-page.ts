import { and, eq } from "drizzle-orm";
import { events, interactions, surveySubmissions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import type { SurveyQuestion } from "@/lib/interaction-config";
import { verifyParticipantToken } from "@/lib/participant-token";
import { questionsOf } from "@/lib/survey";

/** What the `/survey/<id>` page needs. Questions only travel while the survey is live. */
export type SurveyPageData =
  | { status: "open"; id: string; title: string; eventName: string; questions: SurveyQuestion[]; submitted: boolean }
  | { status: "notOpen" | "closed"; id: string; title: string; eventName: string };

export async function hasSubmitted(interactionId: string, participantId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: surveySubmissions.id })
    .from(surveySubmissions)
    .where(and(eq(surveySubmissions.interactionId, interactionId), eq(surveySubmissions.participantId, participantId)));
  return Boolean(row);
}

/** `null` when the id is not a survey. `participantToken` reads the event's participant cookie. */
export async function getSurveyPage(
  id: string,
  participantToken: (eventId: string) => string | undefined,
): Promise<SurveyPageData | null> {
  if (!isUuid(id)) return null;
  const [row] = await getDb()
    .select({
      eventId: interactions.eventId,
      type: interactions.type,
      title: interactions.title,
      state: interactions.state,
      config: interactions.config,
      eventName: events.name,
    })
    .from(interactions)
    .innerJoin(events, eq(events.id, interactions.eventId))
    .where(eq(interactions.id, id));
  if (!row || row.type !== "survey") return null;
  const base = { id, title: row.title, eventName: row.eventName };
  if (row.state === "closed") return { status: "closed", ...base };
  if (row.state !== "live") return { status: "notOpen", ...base };
  const token = participantToken(row.eventId);
  const participantId = token ? verifyParticipantToken(token, row.eventId) : null;
  const submitted = participantId && isUuid(participantId) ? await hasSubmitted(id, participantId) : false;
  return { status: "open", ...base, questions: questionsOf(row.config), submitted };
}
