import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: replace, replace }) }));

import { JoinRedirect } from "@/components/join-redirect";

beforeEach(() => replace.mockReset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("joins directly and goes to the participant view", async () => {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ event: { id: "e1" }, participant: { id: "p1" } })),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<JoinRedirect code="123456" />);
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/e/e1"));
  expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({
    code: "123456",
  });
});

it("shows 'Event not found' for a bad link", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: "Event not found" }), { status: 404 })),
  );
  render(<JoinRedirect code="999999" />);
  expect((await screen.findByRole("alert")).textContent).toBe("Event not found");
  expect(replace).not.toHaveBeenCalled();
});
