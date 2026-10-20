import { isUuid } from "@/lib/events";
import { serverT } from "@/lib/i18n/server";
import type { OpsActionError } from "@/lib/ops-actions";

const STATUS: Record<OpsActionError, number> = { not_found: 404, reason: 400, plan: 400, until: 400, already: 409 };
const MESSAGE = {
  not_found: "ops.workspaceNotFound",
  reason: "ops.reasonRequired",
  plan: "ops.planInvalid",
  until: "ops.untilInvalid",
  already: "ops.alreadyDone",
} as const satisfies Record<OpsActionError, string>;

/** The answer for a refused operator action; `reason` names the field or rule so the screen can point at it. */
export function opsErrorResponse(request: Request, error: OpsActionError): Response {
  return Response.json({ error: serverT(request, MESSAGE[error]), reason: error }, { status: STATUS[error] });
}

export function opsNotFound(request: Request): Response {
  return opsErrorResponse(request, "not_found");
}

export const validId = isUuid;
