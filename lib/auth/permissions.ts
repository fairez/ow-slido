export const ROLES = ["owner", "admin", "editor", "moderator", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = [
  "billing.manage",
  "members.manage",
  "branding.manage",
  "templates.manage",
  "event.create",
  "event.edit",
  "event.delete",
  "live.run",
  "moderate",
  "insights.manage",
  "export",
  "results.view",
  "audit.view",
] as const;
export type Action = (typeof ACTIONS)[number];

type Grant = true | "own";

// Section 7 of tasks/prd-slido-clone-phase3.md. A missing role means no access.
const MATRIX: Record<Action, Partial<Record<Role, Grant>>> = {
  "billing.manage": { owner: true },
  "members.manage": { owner: true, admin: true },
  "branding.manage": { owner: true, admin: true },
  "templates.manage": { owner: true, admin: true },
  "event.create": { owner: true, admin: true, editor: true },
  "event.edit": { owner: true, admin: true, editor: true },
  "event.delete": { owner: true, admin: true, editor: "own" },
  "live.run": { owner: true, admin: true, editor: true, moderator: true },
  moderate: { owner: true, admin: true, editor: true, moderator: true },
  "insights.manage": { owner: true, admin: true, editor: true },
  export: { owner: true, admin: true, editor: true, viewer: true },
  "results.view": { owner: true, admin: true, editor: true, moderator: true, viewer: true },
  "audit.view": { owner: true, admin: true },
};

export function can(role: Role, action: Action, opts: { ownsContent?: boolean } = {}): boolean {
  const grant = MATRIX[action][role];
  if (grant === "own") return opts.ownsContent === true;
  return grant === true;
}
