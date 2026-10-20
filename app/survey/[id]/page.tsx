import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { EventUnavailable } from "@/components/event-unavailable";
import { SurveyForm } from "@/components/survey-form";
import { participantCookieName } from "@/lib/participant-token";
import { getSurveyPage } from "@/lib/survey-page";

export const dynamic = "force-dynamic";

/** The survey's own link: it works while the survey is live, whatever else is on screen in the event. */
export default async function SurveyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jar = await cookies();
  const survey = await getSurveyPage(id, (eventId) => jar.get(participantCookieName(eventId))?.value);
  if (!survey) notFound();
  if (survey.status === "unavailable") {
    return (
      <main id="main" className="participant">
        <EventUnavailable />
      </main>
    );
  }
  return (
    <main id="main" className="participant">
      <SurveyForm survey={survey} />
    </main>
  );
}
