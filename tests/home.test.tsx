import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: push }) }));

vi.mock("@/lib/i18n/server", async () => {
  const { t } = await import("@/lib/i18n");
  return { getT: async () => (key: Parameters<typeof t>[1], params?: Parameters<typeof t>[2]) => t("en", key, params) };
});

import Home from "@/app/page";

beforeEach(() => push.mockReset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("renders a code input and Join button", async () => {
  render(await Home());
  expect(screen.getByRole("heading", { name: "Join an event" })).toBeTruthy();
  expect(screen.getByLabelText("Event code")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Join event" })).toBeTruthy();
});

it("shows 'Event not found' for an invalid code", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: "Event not found" }), { status: 404 })),
  );
  render(await Home());
  fireEvent.change(screen.getByLabelText("Event code"), { target: { value: "000000" } });
  fireEvent.click(screen.getByRole("button", { name: "Join event" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Event not found");
  expect(push).not.toHaveBeenCalled();
});

it("routes to the participant view on success", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ event: { id: "e1" }, participant: { id: "p1" } }))),
  );
  render(await Home());
  fireEvent.change(screen.getByLabelText("Event code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Join event" }));
  await waitFor(() => expect(push).toHaveBeenCalledWith("/e/e1?j=1"));
});

it("links to the public pricing page", async () => {
  render(await Home());
  expect(screen.getByRole("link", { name: "See plans and prices" }).getAttribute("href")).toBe("/pricing");
});
