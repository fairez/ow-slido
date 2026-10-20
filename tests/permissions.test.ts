import { describe, expect, it } from "vitest";
import { ACTIONS, ROLES, can, type Action, type Role } from "@/lib/auth/permissions";

const Y = true;
const N = false;
// Columns: owner, admin, editor, moderator, viewer.
const EXPECTED: Record<Action, [boolean, boolean, boolean, boolean, boolean]> = {
  "billing.manage": [Y, N, N, N, N],
  "members.manage": [Y, Y, N, N, N],
  "branding.manage": [Y, Y, N, N, N],
  "templates.manage": [Y, Y, N, N, N],
  "event.create": [Y, Y, Y, N, N],
  "event.edit": [Y, Y, Y, N, N],
  "event.delete": [Y, Y, N, N, N], // editor: own only, see below
  "live.run": [Y, Y, Y, Y, N],
  moderate: [Y, Y, Y, Y, N],
  "insights.manage": [Y, Y, Y, N, N],
  export: [Y, Y, Y, N, Y],
  "results.view": [Y, Y, Y, Y, Y],
  "audit.view": [Y, Y, N, N, N],
};

describe("permission matrix", () => {
  const cells = ACTIONS.flatMap((action) =>
    ROLES.map((role, i) => [action, role, EXPECTED[action][i]] as [Action, Role, boolean]),
  );

  it.each(cells)("%s / %s -> %s", (action, role, allowed) => {
    expect(can(role, action)).toBe(allowed);
    expect(can(role, action, { ownsContent: false })).toBe(allowed);
  });

  it("covers every action", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ACTIONS].sort());
  });

  it("lets editors delete only content they own", () => {
    expect(can("editor", "event.delete", { ownsContent: true })).toBe(true);
    expect(can("editor", "event.delete", { ownsContent: false })).toBe(false);
    expect(can("editor", "event.delete")).toBe(false);
  });

  it("ownership does not widen other roles", () => {
    expect(can("moderator", "event.delete", { ownsContent: true })).toBe(false);
    expect(can("viewer", "event.delete", { ownsContent: true })).toBe(false);
    expect(can("editor", "billing.manage", { ownsContent: true })).toBe(false);
  });
});
