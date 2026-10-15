import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LogoutButton } from "@/components/logout-button";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const user = await getUserFromToken(token);
  if (!user) redirect("/login");

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 16 }}>
      <h1>Dashboard</h1>
      <p>
        Signed in as <strong>{user.email}</strong>
      </p>
      <LogoutButton />
    </main>
  );
}
