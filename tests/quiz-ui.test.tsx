import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QuizForm } from "@/components/quiz-form";
import type { LiveQuiz } from "@/lib/live-view";

const NOW = Date.parse("2026-11-01T09:00:00Z");

const live = (extra: Partial<LiveQuiz> = {}): LiveQuiz => ({
  id: "q1",
  type: "quiz",
  title: "Islands",
  state: "live",
  prompt: "Which is the biggest?",
  options: [
    { id: "a", text: "Java" },
    { id: "b", text: "Borneo" },
    { id: "c", text: "Bali" },
  ],
  multiple: false,
  timeLimitSeconds: 20,
  deadlineAt: NOW + 20_000,
  serverNow: NOW,
  mine: null,
  ...extra,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const announcement = () => screen.getAllByRole("status").map((s) => s.textContent).join("|");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("gives every option a different shape and colour slot", () => {
  render(<QuizForm quiz={live()} />);
  const buttons = screen.getAllByRole("button");
  expect(buttons.map((b) => b.getAttribute("data-n"))).toEqual(["1", "2", "3"]);
  const shapes = buttons.map((b) => b.querySelector("svg")?.innerHTML);
  expect(new Set(shapes).size).toBe(3);
  expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Java", "Borneo", "Bali"]);
});

it("locks and sends on the first tap of a single-answer question", async () => {
  const fetchMock = vi.fn(async () => json({ ok: true }, 201));
  vi.stubGlobal("fetch", fetchMock);
  render(<QuizForm quiz={live()} />);
  fireEvent.click(screen.getByRole("button", { name: "Borneo" }));
  await waitFor(() => expect(screen.getByText(/Answer sent/)).toBeTruthy());
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/api/interactions/q1/quiz-answer");
  expect(JSON.parse(init.body as string)).toEqual({ optionIds: ["b"] });
  fireEvent.click(screen.getByRole("button", { name: /Java/ }));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: /Borneo/ }).textContent).toContain("Selected");
});

it("lets a multiple-answer question be changed until it is sent", async () => {
  const fetchMock = vi.fn(async () => json({ ok: true }, 201));
  vi.stubGlobal("fetch", fetchMock);
  render(<QuizForm quiz={live({ multiple: true })} />);
  fireEvent.click(screen.getByRole("button", { name: "Java" }));
  fireEvent.click(screen.getByRole("button", { name: "Bali" }));
  // A selected option's name carries "Selected", so a screen reader hears the state too.
  fireEvent.click(screen.getByRole("button", { name: "Java Selected" }));
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ optionIds: ["c"] });
});

it("shows the same locked state after a reload", () => {
  render(<QuizForm quiz={live({ mine: ["a"] })} />);
  expect(screen.getByText(/Answer sent/)).toBeTruthy();
  expect(screen.getByRole("button", { name: /Java/ }).getAttribute("aria-pressed")).toBe("true");
});

it("counts down from the server deadline even when the device clock is wrong", () => {
  // The phone runs 5 minutes fast: its Date.now() is far ahead of the server's.
  render(<QuizForm quiz={live({ serverNow: NOW - 300_000, deadlineAt: NOW - 300_000 + 20_000 })} />);
  expect(document.querySelector(".quiz-timer-seconds")?.textContent).toBe("20");
  tick(3000);
  expect(document.querySelector(".quiz-timer-seconds")?.textContent).toBe("17");
});

it("announces the time at 10 and 5 seconds only, and when time is up", () => {
  render(<QuizForm quiz={live()} />);
  tick(9000);
  expect(announcement()).not.toMatch(/seconds left/);
  tick(1000);
  expect(announcement()).toContain("10 seconds left");
  tick(3000);
  expect(announcement()).toContain("10 seconds left");
  tick(2000);
  expect(announcement()).toContain("5 seconds left");
  tick(5000);
  expect(announcement()).toContain("Time is up");
  expect(screen.getByRole("button", { name: "Java" }).getAttribute("aria-disabled")).toBe("true");
  // The visible countdown is hidden from assistive technology.
  expect(document.querySelector(".quiz-timer")).toBeNull();
});

it("does not send once the time is up", () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  render(<QuizForm quiz={live()} />);
  tick(21_000);
  fireEvent.click(screen.getByRole("button", { name: "Java" }));
  expect(fetchMock).not.toHaveBeenCalled();
});

it("treats a time-up answer from the server as closed", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Time is up" }, 409)));
  render(<QuizForm quiz={live()} />);
  fireEvent.click(screen.getByRole("button", { name: "Java" }));
  await waitFor(() => expect(screen.getByText("Answers are closed. Wait for the host to show the result.")).toBeTruthy());
});

it("after close shows correct or not, the points and the correct options", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ answered: true, optionIds: ["a"], correct: false, points: 0, correctOptionIds: ["b"] })),
  );
  render(<QuizForm quiz={live({ state: "closed", mine: ["a"] })} />);
  expect(screen.getByText("Checking your answer")).toBeTruthy();
  await waitFor(() => expect(screen.getByText("Not this time")).toBeTruthy());
  expect(screen.getByText("0 points")).toBeTruthy();
  const items = screen.getAllByRole("listitem").map((li) => li.textContent?.trim());
  expect(items).toEqual(["Java Your answer", "Borneo Correct answer", "Bali"]);
});

it("after close a right answer shows its points", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ answered: true, optionIds: ["b"], correct: true, points: 870, correctOptionIds: ["b"] })),
  );
  render(<QuizForm quiz={live({ state: "closed", mine: ["b"] })} />);
  await waitFor(() => expect(screen.getByText("Correct")).toBeTruthy());
  expect(screen.getByText("870 points")).toBeTruthy();
});

it("after close without an answer says so", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ answered: false, optionIds: [], correct: false, points: 0, correctOptionIds: ["b"] })),
  );
  render(<QuizForm quiz={live({ state: "closed" })} />);
  await waitFor(() => expect(screen.getByText("No answer sent")).toBeTruthy());
});
