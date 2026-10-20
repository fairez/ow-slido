import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

import { InviteAcceptForm } from "@/components/invite-accept-form";

const ui = (email: string | null) => (
  <I18nProvider locale="en">
    <InviteAcceptForm token="tok" signedInEmail={email} />
  </I18nProvider>
);

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("asks a new person for a password and goes to the dashboard", async () => {
  const fetchMock = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  render(ui(null));
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "long-enough-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Create account and join" }));
  await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/invitations/accept",
    expect.objectContaining({ body: JSON.stringify({ token: "tok", password: "long-enough-1" }) }),
  );
});

it("only needs a click when signed in", async () => {
  const fetchMock = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  render(ui("me@x.test"));
  expect(screen.queryByLabelText("New password")).toBeNull();
  expect(screen.getByText(/signed in as me@x.test/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
  await waitFor(() => expect(push).toHaveBeenCalled());
  expect(fetchMock).toHaveBeenCalledWith("/api/invitations/accept", expect.objectContaining({ body: JSON.stringify({ token: "tok" }) }));
});

it("sends an existing account to log in", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "An account with this email already exists.", reason: "login_required" }, { status: 401 })),
  );
  render(ui(null));
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "long-enough-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Create account and join" }));
  expect((await screen.findByRole("alert")).textContent).toContain("already exists");
  expect(screen.getByRole("link", { name: "Log in" }).getAttribute("href")).toBe("/login");
  expect(push).not.toHaveBeenCalled();
});

it("offers log out when the account has the wrong email", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Different address.", reason: "wrong_email" }, { status: 403 })));
  render(ui("me@x.test"));
  fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
  await screen.findByText("Different address.");
  expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy();
});
