import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { PresenterView } from "@/components/presenter-view";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { asc, eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { findOwnedEvent } from "@/lib/polls";
import { getPresenterState } from "@/lib/presenter";

export const dynamic = "force-dynamic";

export default async function PresentPage({ params }: { params: Promise<{ eventId: string }> }) {
  const user = await getUserFromToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");

  const event = await findOwnedEvent((await params).eventId, user.id);
  if (!event) notFound();

  const items = await getDb()
    .select({ id: interactions.id, state: interactions.state })
    .from(interactions)
    .where(eq(interactions.eventId, event.id))
    .orderBy(asc(interactions.position), asc(interactions.createdAt));

  return (
    <main id="main" className="present" style={{ minHeight: "100vh", padding: 32, background: "#000", color: "#fff" }}>
      <PresenterView
        eventId={event.id} 
        initial={await getPresenterState(event.id)}
        joinCode={event.joinCode}
        items={items}
      />
    </main>
  );
}
