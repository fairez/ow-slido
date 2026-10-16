import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { events } from "@/db/schema";
import { EventManager } from "@/components/event-manager";
import { getDb } from "@/lib/db";
import { LogoutButton } from "@/components/logout-button";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const user = await getUserFromToken(token);
  if (!user) redirect("/login");

  const list = await getDb()
    .select()
    .from(events)
    .where(eq(events.ownerId, user.id))
    .orderBy(asc(events.startsAt), asc(events.createdAt));
  const initialEvents = list.map((e) => ({
    id: e.id,
    name: e.name,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt.toISOString(),
    joinCode: e.joinCode,
  }));

  return (
    <main id="main" className="page">
      <header className="page-head">
        <div>
          <h1>Your events</h1>
          <p className="row-meta">Signed in as {user.email}</p>
        </div>
        <LogoutButton />
      </header>
      <EventManager initialEvents={initialEvents} />
    </main>
  );
}
