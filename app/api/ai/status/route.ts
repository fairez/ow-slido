import { aiStatus } from "@/lib/ai";
import { requireAdmin } from "@/lib/auth/require-admin";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  return Response.json(aiStatus());
}
