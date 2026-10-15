import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: push }) }));

import Home from "@/app/page";

beforeEach(() => push.mockReset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("renders a code input and Join button", () => {
  render(<Home />);
  expect(screen.getByRole("heading", { name: "OW Slido" })).toBeTruthy();
  expect(screen.getByLabelText("Event code")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Join" })).toBeTruthy();
});

it("shows 'Event not found' for an invalid code", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: "Event not found" }), { status: 404 })),
  );
  render(<Home />);
  fireEvent.change(screen.getByLabelText("Event code"), { target: { value: "000000" } });
  fireEvent.click(screen.getByRole("button", { name: "Join" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Event not found");
  expect(push).not.toHaveBeenCalled();
});

it("routes to the participant view on success", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ event: { id: "e1" }, participant: { id: "p1" } }))),
  );
  render(<Home />);
  fireEvent.change(screen.getByLabelText("Event code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Join" }));
  await waitFor(() => expect(push).toHaveBeenCalledWith("/e/e1"));
});
