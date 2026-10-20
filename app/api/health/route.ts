import { getHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

/**
 * Deploy health check, no auth and no data: 200 when the database answers and every migration is applied, with
 * the state of the recurring jobs and the export/analysis runner; 503 when it is unreachable or migrations are
 * missing (the deploy then fails visibly instead of serving an app whose tables do not exist).
 */
export async function GET() {
  const { status, body } = await getHealth();
  return Response.json(body, { status });
}
