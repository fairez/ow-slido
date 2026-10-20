import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { PresenterView } from "@/components/presenter-view";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { WORKSPACE_COOKIE, resolveActiveMembership } from "@/lib/auth/workspace";
import { asc, eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { findOwnedEvent } from "@/lib/polls";
import { getPresenterState, getSurveyPresenter } from "@/lib/presenter";
import { listApprovedQuestions, resolveEventQa } from "@/lib/questions";

export const dynamic = "force-dynamic";

const initialScreen = (view?: string) => (view === "qa" || view === "podium" ? view : "interaction");

export default async function PresentPage({
  params,
  searchParams,
}: {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<{ view?: string; survey?: string }>;
}) {
  const user = await getUserFromToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/account/password");
  const membership = resolveActiveMembership(user.memberships, (await cookies()).get(WORKSPACE_COOKIE)?.value);
  if (!membership) notFound();

  const event = await findOwnedEvent((await params).eventId, membership.workspaceId);
  if (!event) notFound();

  const items = await getDb()
    .select({ id: interactions.id, state: interactions.state, type: interactions.type, title: interactions.title })
    .from(interactions)
    .where(eq(interactions.eventId, event.id))
    .orderBy(asc(interactions.position), asc(interactions.createdAt));

  const qaId = await resolveEventQa(getDb(), event.id);
  const query = await searchParams;
  // `?view=survey&survey=<id>` opens a survey's results; an id that is not a shown survey of this event falls back.
  const survey = query.view === "survey" && query.survey ? await getSurveyPresenter(event.id, query.survey) : null;

  return (
    <main id="main" className="present">
      <PresenterView
        eventId={event.id}
        initial={await getPresenterState(event.id)}
        joinCode={event.joinCode}
        items={items}
        initialQuestions={qaId ? await listApprovedQuestions(qaId) : []}
        initialQaId={qaId}
        initialScreen={survey ? "survey" : initialScreen(query.view)}
        initialSurvey={survey}
      />
    </main>
  );
}
