import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

import { WorkspaceSwitcher } from "@/components/workspace-switcher";

const one = [{ id: "w1", name: "Acme", role: "owner" }];
const two = [...one, { id: "w2", name: "Beta", role: "viewer" }];
const ui = (list: typeof two, activeId: string) => (
  <I18nProvider locale="en">
    <WorkspaceSwitcher workspaces={list} activeId={activeId} />
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

it("shows only the name and role for a single workspace", () => {
  render(ui(one, "w1"));
  expect(screen.getByText("Acme")).toBeTruthy();
  expect(screen.getByText("Owner")).toBeTruthy();
  expect(screen.queryByRole("combobox")).toBeNull();
});

it("lists workspaces and posts the choice", async () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  render(ui(two, "w1"));
  const select = screen.getByRole("combobox", { name: "Switch workspace" }) as HTMLSelectElement;
  expect(select.value).toBe("w1");
  expect(screen.getByRole("option", { name: "Beta (Viewer)" })).toBeTruthy();
  fireEvent.change(select, { target: { value: "w2" } });
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/workspaces/active",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ workspaceId: "w2" }) }),
  );
});

it("shows an error when the switch is refused", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
  render(ui(two, "w1"));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "w2" } });
  expect((await screen.findByRole("alert")).textContent).toContain("Could not switch");
  expect(refresh).not.toHaveBeenCalled();
});
