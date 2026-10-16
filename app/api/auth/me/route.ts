import { getSessionUser } from "@/lib/auth/require-admin";

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ user });
}
