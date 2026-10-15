import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { PollManager, type InteractionItem } from "@/components/poll-manager";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
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

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 16 }}>
      <Link href="/dashboard">← Dashboard</Link>
      <h1>{event.name}</h1>
      <p>
        Join code: <strong>{event.joinCode}</strong>
      </p>
      <PollManager eventId={event.id} initialInteractions={list as InteractionItem[]} />
    </main>
  );
}
