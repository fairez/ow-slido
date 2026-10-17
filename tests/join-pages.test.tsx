import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: replace, replace }) }));

import { JoinRedirect, NAVIGATION_STALL_MS } from "@/components/join-redirect";
import { JOIN_TIMEOUT_MS, joinEvent } from "@/lib/join-client";

beforeEach(() => replace.mockReset());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("joins directly and goes to the participant view", async () => {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ event: { id: "e1" }, participant: { id: "p1" } })),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<JoinRedirect code="123456" />);
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/e/e1?j=1"));
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

const okFetch = () =>
  vi.fn(async () => new Response(JSON.stringify({ event: { id: "e1" }, participant: { id: "p1" } })));

it("explains blocked cookies instead of joining again, so the redirect cannot loop", () => {
  const fetchMock = okFetch();
  vi.stubGlobal("fetch", fetchMock);
  render(<JoinRedirect code="123456" cookiesBlocked />);
  expect(screen.getByRole("heading", { name: "Cookies are blocked" })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toMatch(/not saving cookies/);
  expect(screen.getByRole("link", { name: "Try again" }).getAttribute("href")).toBe("/join/123456");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

it("offers a manual link when the participant page does not open in time", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("fetch", okFetch());
  render(<JoinRedirect code="123456" />);
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/e/e1?j=1"));
  expect(screen.queryByRole("link", { name: /Continue to the event/ })).toBeNull();
  await act(async () => void (await vi.advanceTimersByTimeAsync(NAVIGATION_STALL_MS + 100)));
  expect(screen.getByRole("link", { name: /Continue to the event/ }).getAttribute("href")).toBe("/e/e1?j=1");
});

it("renders the 'taking longer' hint and a noscript message in the initial HTML, for browsers that never run scripts", () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  const { container } = render(<JoinRedirect code="123456" />);
  expect(container.querySelector(".join-stuck")?.textContent).toMatch(/taking longer than usual/);
  expect(container.querySelector("noscript")).not.toBeNull();
});

it("a failed join offers a retry", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Too many attempts. Try again shortly." }), { status: 429 })));
  render(<JoinRedirect code="123456" />);
  expect((await screen.findByRole("alert")).textContent).toMatch(/Too many attempts/);
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

it("gives up on a join request that never answers", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))),
  );
  const pending = joinEvent("123456");
  await vi.advanceTimersByTimeAsync(JOIN_TIMEOUT_MS + 10);
  expect(await pending).toEqual({ ok: false, error: expect.stringMatching(/taking too long/) });
});
