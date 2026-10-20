export const WORKSPACE_COOKIE = "workspace";

export type MembershipInfo = {
  workspaceId: string;
  role: "owner" | "admin" | "editor" | "moderator" | "viewer";
  status: "active" | "suspended";
};

/**
 * The workspace a request acts in: the one named by the `workspace` cookie if the user is an active
 * member there, otherwise their first active membership. Null when the user has no active membership.
 */
export function resolveActiveMembership(
  memberships: MembershipInfo[],
  preferredId: string | null | undefined,
): MembershipInfo | null {
  const active = memberships.filter((m) => m.status === "active");
  return active.find((m) => m.workspaceId === preferredId) ?? active[0] ?? null;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export function workspaceSetCookie(workspaceId: string, secure: boolean) {
  return `${WORKSPACE_COOKIE}=${workspaceId}; Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`;
}
