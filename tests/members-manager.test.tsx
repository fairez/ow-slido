import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MembersManager, type InvitationRow, type MemberRow } from "@/components/members-manager";
import { I18nProvider } from "@/lib/i18n/client";
import type { Role } from "@/lib/auth/permissions";

const member = (id: string, email: string, role: Role, status: "active" | "suspended" = "active"): MemberRow => ({
  userId: id,
  email,
  role,
  status,
  joinedAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: id === "o1" ? "2026-10-01T08:00:00.000Z" : null,
  twoFactor: id === "o1",
});
const MEMBERS = [member("o1", "owner@x.test", "owner"), member("e1", "ed@x.test", "editor"), member("v1", "view@x.test", "viewer", "suspended")];
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const INVITES: InvitationRow[] = [
  { id: "i1", email: "new@x.test", role: "moderator", status: "pending", expiresAt: FUTURE },
  { id: "i2", email: "old@x.test", role: "viewer", status: "revoked", expiresAt: FUTURE },
];

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function stubFetch(handler: Handler) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const isGet = !init?.method || init.method === "GET";
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (isGet && url === "/api/members") return Response.json({ members: MEMBERS, selfId: "o1" });
      if (isGet && url === "/api/invitations") return Response.json({ invitations: INVITES });
      return handler(url, init);
    }),
  );
  return calls;
}

function ui(actorRole: Role = "owner", selfId = "o1") {
  return render(
    <I18nProvider locale="en">
      <MembersManager selfId={selfId} actorRole={actorRole} initialMembers={MEMBERS} initialInvitations={INVITES} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MembersManager", () => {
  it("lists members with status, last login and only pending invitations", () => {
    ui();
    expect(screen.getByText("Last login 2026-10-01")).toBeTruthy();
    expect(screen.getAllByText("Has not logged in yet")).toHaveLength(2);
    expect(screen.getByText("Suspended")).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("new@x.test")).toBeTruthy();
    expect(screen.queryByText("old@x.test")).toBeNull();
  });

  it("hides controls the viewer's role cannot use", () => {
    ui("admin", "a1");
    const ownerRow = screen.getByText("owner@x.test").closest("li") as HTMLElement;
    expect(within(ownerRow).queryByRole("button")).toBeNull();
    expect(within(ownerRow).queryByRole("combobox")).toBeNull();
    const editorRow = screen.getByText("ed@x.test").closest("li") as HTMLElement;
    const options = within(within(editorRow).getByRole("combobox")).getAllByRole("option").map((o) => o.textContent);
    expect(options).not.toContain("Owner");
  });

  it("does not offer controls on your own row", () => {
    ui();
    const own = screen.getByText("owner@x.test").closest("li") as HTMLElement;
    expect(within(own).queryByRole("button")).toBeNull();
  });

  it("changes a role and shows the API error in the page", async () => {
    const calls = stubFetch(() => Response.json({ error: "A workspace needs at least one active owner." }, { status: 409 }));
    ui();
    fireEvent.change(screen.getByRole("combobox", { name: "Role for ed@x.test" }), { target: { value: "admin" } });
    expect((await screen.findByRole("alert")).textContent).toContain("at least one active owner");
    expect(calls[0]).toMatchObject({ url: "/api/members/e1", method: "PATCH", body: { role: "admin" } });
  });

  it("reactivates a suspended member", async () => {
    const calls = stubFetch(() => Response.json({ ok: true }));
    ui();
    fireEvent.click(screen.getByRole("button", { name: "Reactivate view@x.test" }));
    await waitFor(() => expect(calls[0]).toMatchObject({ method: "PATCH", body: { status: "active" } }));
  });

  it("shows the temporary password once, with a copy button, and returns focus", async () => {
    stubFetch(() => Response.json({ temporaryPassword: "Tmp-pass-1234" }));
    ui();
    const opener = screen.getByRole("button", { name: "Reset password for ed@x.test" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: /^Reset password$/ }));
    const field = (await screen.findByRole("textbox", { name: "Temporary password" })) as HTMLInputElement;
    expect(field.value).toBe("Tmp-pass-1234");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Tmp-pass-1234"));
    expect((await screen.findByText("Copied")).getAttribute("role")).toBe("status");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("asks before removing and keeps the dialog open on error", async () => {
    const calls = stubFetch(() => Response.json({ error: "Not allowed" }, { status: 403 }));
    ui();
    fireEvent.click(screen.getByRole("button", { name: "Remove ed@x.test" }));
    expect(screen.getByRole("dialog", { name: "Remove ed@x.test?" })).toBeTruthy();
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Remove member" }));
    expect((await within(screen.getByRole("dialog")).findByRole("alert")).textContent).toBe("Not allowed");
    expect(calls[0]).toMatchObject({ url: "/api/members/e1", method: "DELETE" });
  });

  it("invites someone and shows the link when the email failed", async () => {
    const calls = stubFetch(() => Response.json({ link: "http://x.test/invite?token=abc", emailSent: false }, { status: 201 }));
    ui();
    fireEvent.click(screen.getByRole("button", { name: "Invite someone" }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "Fresh@x.test" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "editor" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    expect(((await screen.findByRole("textbox", { name: "Invitation link" })) as HTMLInputElement).value).toBe("http://x.test/invite?token=abc");
    expect(screen.getByText(/could not send the email/i)).toBeTruthy();
    expect(calls[0]).toMatchObject({ url: "/api/invitations", method: "POST", body: { email: "Fresh@x.test", role: "editor" } });
  });

  it("revokes a pending invitation", async () => {
    const calls = stubFetch(() => Response.json({ ok: true }));
    ui();
    fireEvent.click(screen.getByRole("button", { name: "Revoke invitation for new@x.test" }));
    await waitFor(() => expect(calls[0]).toMatchObject({ url: "/api/invitations/i1", method: "DELETE" }));
  });

  it("shows who has 2FA on", () => {
    ui();
    const ownerRow = screen.getByText("owner@x.test").closest("li") as HTMLElement;
    expect(within(ownerRow).getByText("2FA on")).toBeTruthy();
    const editorRow = screen.getByText("ed@x.test").closest("li") as HTMLElement;
    expect(within(editorRow).getByText("2FA off")).toBeTruthy();
  });

  describe("2FA requirement", () => {
    const withPolicy = (twoFactorPolicy: { required: boolean; lock?: { requiredPlan: "team" } }) =>
      render(
        <I18nProvider locale="en">
          <MembersManager selfId="o1" actorRole="owner" initialMembers={MEMBERS} initialInvitations={INVITES} twoFactorPolicy={twoFactorPolicy} />
        </I18nProvider>,
      );

    it("is hidden without a policy", () => {
      ui();
      expect(screen.queryByText("Require two-factor authentication for everyone")).toBeNull();
    });

    it("turns the requirement on and reports a refusal", async () => {
      const calls = stubFetch(() => Response.json({ require2fa: true }));
      withPolicy({ required: false });
      const toggle = screen.getByRole("checkbox", { name: "Require two-factor authentication for everyone" }) as HTMLInputElement;
      fireEvent.click(toggle);
      await waitFor(() => expect(toggle.checked).toBe(true));
      expect(calls[0]).toMatchObject({ url: "/api/workspaces/active/security", method: "PATCH", body: { require2fa: true } });

      stubFetch(() => Response.json({ error: "Not allowed" }, { status: 403 }));
      fireEvent.click(toggle);
      expect(await screen.findByText("Not allowed")).toBeTruthy();
      expect(toggle.checked).toBe(true);
    });

    it("becomes a plan hint when the plan cannot enforce it", () => {
      withPolicy({ required: false, lock: { requiredPlan: "team" } });
      expect(screen.queryByRole("checkbox", { name: /Require two-factor/ })).toBeNull();
      expect(screen.getByRole("link", { name: "Require two-factor authentication for everyone Team plan" }).getAttribute("href")).toBe("/dashboard/plan");
    });
  });
});
