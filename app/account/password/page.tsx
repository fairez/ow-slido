import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ChangePasswordForm } from "@/components/password-forms";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function ChangePasswordPage() {
  const user = await getUserFromToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  return <ChangePasswordForm forced={user.mustChangePassword} />;
}
