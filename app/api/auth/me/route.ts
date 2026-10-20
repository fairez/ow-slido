import { serverT } from "@/lib/i18n/server";
import { getSessionUser } from "@/lib/auth/require-admin";

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return Response.json({ error: serverT(request, "api.unauthorized") }, { status: 401 });
  return Response.json({ user });
}
