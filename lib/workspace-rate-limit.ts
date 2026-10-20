import { rateLimit } from "@/lib/rate-limit";
import { serverT } from "@/lib/i18n/server";

/**
 * Ceilings per workspace and hour for host actions that cost the server something. They sit on the
 * same rate-limit interface as the audience limits (which stay per IP and per participant token) and
 * count the whole workspace, so adding members or IPs does not raise them.
 */
export const WORKSPACE_LIMITS = {
  /** Single CSV downloads of one event. */
  export: { limit: 60, windowSeconds: 60 * 60 },
  /** Event ZIPs and whole-workspace export jobs: the heavy ones. */
  zip: { limit: 10, windowSeconds: 60 * 60 },
  /** Analysis starts, on top of the plan's monthly AI budget. */
  ai: { limit: 20, windowSeconds: 60 * 60 },
  invitation: { limit: 30, windowSeconds: 60 * 60 },
} as const;

export type WorkspaceAction = keyof typeof WORKSPACE_LIMITS;

/** Counts one hit for the action; `allowed` is false once the workspace is over its ceiling. */
export async function workspaceRateLimit(workspaceId: string, action: WorkspaceAction) {
  const { limit, windowSeconds } = WORKSPACE_LIMITS[action];
  return rateLimit(`workspace:${workspaceId}:${action}`, limit, windowSeconds);
}

/** Runs the check and returns the 429 to send, or null when the call may go on. */
export async function workspaceRateLimited(request: Request, workspaceId: string, action: WorkspaceAction) {
  const result = await workspaceRateLimit(workspaceId, action);
  if (result.allowed) return null;
  return Response.json(
    { error: serverT(request, "api.workspaceRateLimited"), retryAfter: result.retryAfterSeconds },
    { status: 429, headers: { "retry-after": String(result.retryAfterSeconds) } },
  );
}
