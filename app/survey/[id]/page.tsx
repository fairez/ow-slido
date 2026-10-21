import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { BrandStyle, brandAttrs } from "@/components/brand-style";
import { EventUnavailable } from "@/components/event-unavailable";
import { LegalLinks } from "@/components/legal-links";
import { SurveyForm } from "@/components/survey-form";
import { interactionAccent } from "@/lib/branding";
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
  const accent = await interactionAccent(id);
  return (
    <main id="main" className="participant" {...brandAttrs(accent)}>
      <BrandStyle accent={accent} />
      <SurveyForm survey={survey} />
      <LegalLinks />
    </main>
  );
}
