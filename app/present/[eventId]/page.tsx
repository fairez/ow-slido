import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { PresenterView } from "@/components/presenter-view";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { findOwnedEvent } from "@/lib/polls";
import { getPresenterState } from "@/lib/presenter";

export const dynamic = "force-dynamic";

export default async function PresentPage({ params }: { params: Promise<{ eventId: string }> }) {
  const user = await getUserFromToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");

  const event = await findOwnedEvent((await params).eventId, user.id);
  if (!event) notFound();

  return (
    <main style={{ minHeight: "100vh", padding: 32, background: "#000", color: "#fff" }}>
      <PresenterView eventId={event.id} initial={await getPresenterState(event.id)} />
    </main>
  );
}
