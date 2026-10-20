import { SERVER_ERROR } from "@/lib/copy";
import type { Lock } from "@/lib/plan-hints";

/** What a failed API call tells the user. `lock` is set for a plan limit (402) so the UI can link to the plan page. */
export type ApiError = { message: string; lock: Lock | null };

export async function apiError(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => null)) as { error?: unknown; requiredPlan?: unknown } | null;
  const message = typeof body?.error === "string" ? body.error : SERVER_ERROR;
  if (response.status !== 402) return { message, lock: null };
  const plan = body?.requiredPlan;
  return { message, lock: { requiredPlan: plan === "free" || plan === "pro" || plan === "team" ? plan : null } };
}
