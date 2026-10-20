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
  nickname: "Rina",
  nicknameLocked: false,
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
  render(<QuizForm eventId="e1" quiz={live()} />);
  const buttons = screen.getAllByRole("button").filter((b) => b.classList.contains("quiz-option"));
  expect(buttons.map((b) => b.getAttribute("data-n"))).toEqual(["1", "2", "3"]);
  const shapes = buttons.map((b) => b.querySelector("svg")?.innerHTML);
  expect(new Set(shapes).size).toBe(3);
  expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Java", "Borneo", "Bali"]);
});

it("locks and sends on the first tap of a single-answer question", async () => {
  const fetchMock = vi.fn(async () => json({ ok: true }, 201));
  vi.stubGlobal("fetch", fetchMock);
  render(<QuizForm eventId="e1" quiz={live()} />);
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
  render(<QuizForm eventId="e1" quiz={live({ multiple: true })} />);
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
  render(<QuizForm eventId="e1" quiz={live({ mine: ["a"] })} />);
  expect(screen.getByText(/Answer sent/)).toBeTruthy();
  expect(screen.getByRole("button", { name: /Java/ }).getAttribute("aria-pressed")).toBe("true");
});

it("counts down from the server deadline even when the device clock is wrong", () => {
  // The phone runs 5 minutes fast: its Date.now() is far ahead of the server's.
  render(<QuizForm eventId="e1" quiz={live({ serverNow: NOW - 300_000, deadlineAt: NOW - 300_000 + 20_000 })} />);
  expect(document.querySelector(".quiz-timer-seconds")?.textContent).toBe("20");
  tick(3000);
  expect(document.querySelector(".quiz-timer-seconds")?.textContent).toBe("17");
});

it("announces the time at 10 and 5 seconds only, and when time is up", () => {
  render(<QuizForm eventId="e1" quiz={live()} />);
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
  render(<QuizForm eventId="e1" quiz={live()} />);
  tick(21_000);
  fireEvent.click(screen.getByRole("button", { name: "Java" }));
  expect(fetchMock).not.toHaveBeenCalled();
});

it("treats a time-up answer from the server as closed", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Time is up" }, 409)));
  render(<QuizForm eventId="e1" quiz={live()} />);
  fireEvent.click(screen.getByRole("button", { name: "Java" }));
  await waitFor(() => expect(screen.getByText("Answers are closed. Wait for the host to show the result.")).toBeTruthy());
});

it("after close shows correct or not, the points and the correct options", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ answered: true, optionIds: ["a"], correct: false, points: 0, correctOptionIds: ["b"] })),
  );
  render(<QuizForm eventId="e1" quiz={live({ state: "closed", mine: ["a"] })} />);
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
  render(<QuizForm eventId="e1" quiz={live({ state: "closed", mine: ["b"] })} />);
  await waitFor(() => expect(screen.getByText("Correct")).toBeTruthy());
  expect(screen.getByText("870 points")).toBeTruthy();
});

it("after close shows the participant's rank and running total", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        answered: true,
        optionIds: ["b"],
        correct: true,
        points: 870,
        correctOptionIds: ["b"],
        standing: { rank: 3, points: 1770, players: 25 },
      }),
    ),
  );
  render(<QuizForm eventId="e1" quiz={live({ state: "closed", mine: ["b"] })} />);
  await waitFor(() => expect(screen.getByText("Rank 3 of 25")).toBeTruthy());
  expect(screen.getByText("1770 points in total")).toBeTruthy();
});

it("after close says so when the participant is not on the leaderboard yet", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ answered: false, optionIds: [], correct: false, points: 0, correctOptionIds: ["b"], standing: null })),
  );
  render(<QuizForm eventId="e1" quiz={live({ state: "closed" })} />);
  await waitFor(() => expect(screen.getByText(/not on the leaderboard yet/)).toBeTruthy());
});

it("after close without an answer says so", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ answered: false, optionIds: [], correct: false, points: 0, correctOptionIds: ["b"] })),
  );
  render(<QuizForm eventId="e1" quiz={live({ state: "closed" })} />);
  await waitFor(() => expect(screen.getByText("No answer sent")).toBeTruthy());
});

it("asks for a nickname before the options and explains the leaderboard", () => {
  render(<QuizForm eventId="e1" quiz={live({ nickname: null })} />);
  expect(screen.getByRole("heading", { name: "Pick a nickname" })).toBeTruthy();
  expect(screen.getByText(/shown on the leaderboard to everyone/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Borneo" })).toBeNull();
  expect(screen.getByText("The timer keeps running while you choose.")).toBeTruthy();
});

it("saves the nickname, then shows the options and the chosen name", async () => {
  const fetchMock = vi.fn(async () => json({ nickname: "Rina" }));
  vi.stubGlobal("fetch", fetchMock);
  render(<QuizForm eventId="e1" quiz={live({ nickname: null })} />);
  fireEvent.change(screen.getByLabelText("Nickname"), { target: { value: "  Rina  " } });
  fireEvent.click(screen.getByRole("button", { name: "Save nickname" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Borneo" })).toBeTruthy());
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/api/events/e1/nickname");
  expect(init.method).toBe("PUT");
  expect(screen.getByText("Playing as Rina")).toBeTruthy();
});

it("shows the server's message when the nickname is taken and keeps the form", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Someone in this event already uses that nickname. Choose another." }, 409)));
  render(<QuizForm eventId="e1" quiz={live({ nickname: null })} />);
  fireEvent.change(screen.getByLabelText("Nickname"), { target: { value: "Rina" } });
  fireEvent.click(screen.getByRole("button", { name: "Save nickname" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/already uses that nickname/));
  expect(screen.getByLabelText("Nickname").getAttribute("aria-invalid")).toBe("true");
  expect(screen.queryByRole("button", { name: "Borneo" })).toBeNull();
});

it("rejects an empty nickname without calling the server", () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  render(<QuizForm eventId="e1" quiz={live({ nickname: null })} />);
  fireEvent.click(screen.getByRole("button", { name: "Save nickname" }));
  expect(screen.getByRole("alert").textContent).toBe("Enter a nickname");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("lets the participant change the nickname before answering, and returns focus to the button", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ nickname: "Dewi" })));
  render(<QuizForm eventId="e1" quiz={live()} />);
  fireEvent.click(screen.getByRole("button", { name: "Change nickname" }));
  expect(screen.queryByRole("button", { name: "Borneo" })).toBeNull();
  const input = screen.getByLabelText("Nickname") as HTMLInputElement;
  expect(input.value).toBe("Rina");
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "Dewi" } });
  fireEvent.click(screen.getByRole("button", { name: "Save nickname" }));
  await waitFor(() => expect(screen.getByText("Playing as Dewi")).toBeTruthy());
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Change nickname" }));
});

it("keeps the old name when the change is cancelled", () => {
  render(<QuizForm eventId="e1" quiz={live()} />);
  fireEvent.click(screen.getByRole("button", { name: "Change nickname" }));
  fireEvent.click(screen.getByRole("button", { name: "Keep Rina" }));
  expect(screen.getByText("Playing as Rina")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Borneo" })).toBeTruthy();
});

it("offers no change once an answer is sent", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ ok: true }, 201)));
  render(<QuizForm eventId="e1" quiz={live()} />);
  fireEvent.click(screen.getByRole("button", { name: "Borneo" }));
  await waitFor(() => expect(screen.getByText(/Answer sent/)).toBeTruthy());
  expect(screen.queryByRole("button", { name: "Change nickname" })).toBeNull();
  expect(screen.getByText("Playing as Rina")).toBeTruthy();
});

it("offers no change when an earlier question of the event was answered", () => {
  render(<QuizForm eventId="e1" quiz={live({ nicknameLocked: true })} />);
  expect(screen.queryByRole("button", { name: "Change nickname" })).toBeNull();
});

it("does not ask for a nickname on a closed question", () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ answered: false, correct: false, points: 0, optionIds: [], correctOptionIds: ["a"] })));
  render(<QuizForm eventId="e1" quiz={live({ state: "closed", nickname: null })} />);
  expect(screen.queryByRole("heading", { name: "Pick a nickname" })).toBeNull();
});
