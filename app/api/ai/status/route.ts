import { aiStatus } from "@/lib/ai";
import { requireMember } from "@/lib/auth/require-admin";

export async function GET(request: Request) {
  const auth = await requireMember(request);
  if (!auth.ok) return auth.response;
  return Response.json(aiStatus());
}
