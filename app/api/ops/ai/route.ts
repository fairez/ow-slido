import { requireOperator } from "@/lib/operator";
import { getOpsAiStatus } from "@/lib/ops-ai";

export async function GET(request: Request) {
  const auth = await requireOperator(request);
  if (!auth.ok) return auth.response;
  return Response.json(await getOpsAiStatus());
}
