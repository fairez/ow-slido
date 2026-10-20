import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = new EventEmitter() as EventEmitter & { off: EventEmitter["removeListener"] };
vi.mock("@/lib/realtime/use-event-socket", () => ({
  useEventSocket: () => ({ socket: fake, status: "connected" }),
}));

import { PresenterView } from "@/components/presenter-view";

const state = (counts: Record<string, number>, total: number) => ({
  type: "poll" as const,
  id: "i1",
  title: "Lunch?",
  options: [
    { id: "a", label: "Pizza" },
    { id: "b", label: "Tacos" },
  ],
  counts,
  total,
});

beforeEach(() => fake.removeAllListeners());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows 'No live interaction' when nothing is live", () => {
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={null} />);
  expect(screen.getByText("No live interaction")).toBeTruthy();
});

it("shows labels, counts, percents and total", () => {
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={state({ a: 3, b: 1 }, 4)} />);
  expect(screen.getByText("3 (75%)")).toBeTruthy();
  expect(screen.getByText("1 (25%)")).toBeTruthy();
  expect(screen.getByText("Total votes: 4")).toBeTruthy();
});

it("updates live from poll:counts", () => {
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={state({ a: 0, b: 0 }, 0)} />);
  expect(screen.getAllByText("0 (0%)").length).toBe(2);
  act(() => {
    fake.emit("poll:counts", { interactionId: "i1", counts: { a: 1, b: 1 }, total: 2 });
  });
  expect(screen.getAllByText("1 (50%)").length).toBe(2);
  expect(screen.getByText("Total votes: 2")).toBeTruthy();
});

it("resyncs on state-changed and shows the empty state when the poll closes", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ interaction: null }))));
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={state({ a: 1, b: 0 }, 1)} />);
  act(() => {
    fake.emit("state-changed", { interactionId: "i1", state: "closed" });
  });
  await waitFor(() => expect(screen.getByText("No live interaction")).toBeTruthy());
});

it("shows the join code and a QR image", async () => {
  render(<PresenterView eventId="e1" initial={null} joinCode="123456" items={[]} />);
  expect(screen.getByText("Join code: 123456")).toBeTruthy();
  await waitFor(() => expect(screen.getByAltText(/QR code to join/)).toBeTruthy());
});

it("ArrowRight starts the next draft interaction", async () => {
  const fetchMock = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
  const items = [
    { id: "i1", state: "live" as const },
    { id: "i2", state: "draft" as const },
  ];
  render(<PresenterView eventId="e1" initial={state({}, 0)} joinCode="1234" items={items} />);
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
  });
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith("/api/events/e1/interactions/i2/start", { method: "POST" }),
  );
});

const cloud = (words: { word: string; count: number }[]) => ({
  type: "wordcloud" as const,
  id: "w1",
  title: "One word for today",
  words,
  total: words.reduce((n, w) => n + w.count, 0),
});

it("renders a word cloud with sizes by frequency, a text list and a count on focus", () => {
  render(
    <PresenterView
      eventId="e1"
      joinCode="1234"
      items={[]}
      initial={cloud([
        { word: "great", count: 5 },
        { word: "ok", count: 1 },
      ])}
    />,
  );
  const big = screen.getByRole("listitem", { name: "great, 5 entries" });
  const small = screen.getByRole("listitem", { name: "ok, 1 entry" });
  expect(parseFloat(big.style.fontSize)).toBeGreaterThan(parseFloat(small.style.fontSize));
  expect(screen.getByText("great: 5")).toBeTruthy();
  expect(screen.queryByText("×5")).toBeNull();
  act(() => big.focus());
  expect(screen.getByText("×5")).toBeTruthy();
  expect(screen.getByText("Total words: 6")).toBeTruthy();
});

it("updates the word cloud live from wordcloud:words", () => {
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={cloud([])} />);
  expect(screen.getByText("No words yet")).toBeTruthy();
  act(() => {
    fake.emit("wordcloud:words", { interactionId: "w1", words: [{ word: "hello", count: 2 }], total: 2 });
  });
  expect(screen.getByText("hello: 2")).toBeTruthy();
});

const note = (id: string, text: string, upvotes: number, createdAt: string, pinned = false) => ({
  id,
  interactionId: "n1",
  text,
  authorName: null,
  pinned,
  createdAt,
  upvotes,
});
const notesState = (state: "live" | "closed" = "live") => ({
  type: "sharedNotes" as const,
  id: "n1",
  title: "Ideas",
  state,
  notes: [
    note("a", "Older but popular", 5, "2026-10-16T10:00:00Z"),
    note("b", "Newest idea", 1, "2026-10-16T11:00:00Z"),
    note("c", "Pinned one", 0, "2026-10-16T09:00:00Z", true),
  ],
});
const order = () => screen.getAllByRole("listitem").map((li) => li.textContent ?? "");

it("shows notes with count, pinned first, and switches between Top upvoted and Newest", () => {
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={notesState()} />);
  expect(screen.getByText("3 notes")).toBeTruthy();
  expect(order()[0]).toContain("Pinned one");
  expect(order()[1]).toContain("Older but popular");
  fireEvent.click(screen.getByRole("button", { name: "Newest" }));
  expect(order()[1]).toContain("Newest idea");
});

it("updates notes live and keeps a closed board on screen", () => {
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={notesState("closed")} />);
  expect(screen.getByText("3 notes (closed)")).toBeTruthy();
  act(() => {
    fake.emit("note:added", { note: note("d", "Fresh", 0, "2026-10-16T12:00:00Z") });
    fake.emit("note:votes", { interactionId: "n1", noteId: "b", upvotes: 9 });
    fake.emit("note:removed", { interactionId: "n1", noteId: "a" });
  });
  expect(screen.getByText("3 notes (closed)")).toBeTruthy();
  expect(screen.queryByText("Older but popular")).toBeNull();
  expect(screen.getByText("9 upvotes")).toBeTruthy();
});

const question = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  text: `Question ${id}`,
  authorName: null,
  answered: false,
  pinned: false,
  createdAt: `2026-11-01T10:0${id}:00.000Z`,
  upvotes: 0,
  upvoted: false,
  ...over,
});

const listItems = () => screen.getAllByRole("listitem").map((li) => li.textContent ?? "");

it("shows a Show Q&A button that swaps the screen, and back", () => {
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={state({ a: 1, b: 0 }, 1)} initialQuestions={[question("1")]} />);
  expect(screen.getByText("Total votes: 1")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Show Q&A/ }));
  expect(screen.getByRole("heading", { name: "Q&A" })).toBeTruthy();
  expect(screen.getByText("Question 1")).toBeTruthy();
  expect(screen.queryByText("Total votes: 1")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Show interaction/ }));
  expect(screen.getByText("Total votes: 1")).toBeTruthy();
});

it("the Q key toggles the screen", () => {
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={null} initialQuestions={[question("1")]} />);
  fireEvent.keyDown(window, { key: "q" });
  expect(screen.getByRole("heading", { name: "Q&A" })).toBeTruthy();
  fireEvent.keyDown(window, { key: "Q" });
  expect(screen.getByText("No live interaction")).toBeTruthy();
});

it("opens on the Q&A screen when asked to (the ?view=qa link)", () => {
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={null} initialQuestions={[]} initialScreen="qa" />);
  expect(screen.getByRole("heading", { name: "Q&A" })).toBeTruthy();
  expect(screen.getByText(/No questions yet. Ask from your phone with code 1234/)).toBeTruthy();
});

it("lists pinned first, answered last, names or Anonymous, and upvote counts", () => {
  const list = [
    question("1", { upvotes: 5, authorName: "Dewi" }),
    question("2", { answered: true, upvotes: 9 }),
    question("3", { pinned: true }),
  ];
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={null} initialQuestions={list} initialScreen="qa" />);
  const items = listItems();
  expect(items[0]).toMatch(/Question 3.*Anonymous.*0 upvotes.*Pinned/);
  expect(items[1]).toMatch(/Question 1.*Dewi.*5 upvotes/);
  expect(items[2]).toMatch(/Question 2.*9 upvotes.*Answered/);
  expect(screen.getByText("3 questions")).toBeTruthy();
});

it("the sort buttons switch between most upvoted and newest", () => {
  const list = [question("1", { upvotes: 9 }), question("2", { upvotes: 0 })];
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={null} initialQuestions={list} initialScreen="qa" />);
  expect(listItems()[0]).toMatch(/Question 1/);
  fireEvent.click(screen.getByRole("button", { name: "Newest" }));
  expect(listItems()[0]).toMatch(/Question 2/);
  expect(screen.getByRole("button", { name: "Newest" }).getAttribute("aria-pressed")).toBe("true");
});

it("stays current from the question events, even while another screen is shown", () => {
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={null} initialQuestions={[question("1")]} initialQaId="qa1" />);
  act(() => {
    fake.emit("question:added", { interactionId: "qa1", question: question("2") });
    fake.emit("question:votes", { interactionId: "qa1", questionId: "1", upvotes: 4 });
  });
  fireEvent.keyDown(window, { key: "q" });
  expect(screen.getByText("2 questions")).toBeTruthy();
  expect(listItems()[0]).toMatch(/Question 1.*4 upvotes/);
  act(() => {
    fake.emit("question:updated", { interactionId: "qa1", questionId: "2", pinned: true, answered: false });
    fake.emit("question:removed", { interactionId: "qa1", questionId: "1" });
  });
  expect(screen.getByText("1 question")).toBeTruthy();
  expect(listItems()[0]).toMatch(/Question 2.*Pinned/);
});

it("resyncs the questions after a reconnect", async () => {
  const fetchMock = vi.fn(async (url: string) =>
    String(url).endsWith("/present/questions")
      ? new Response(JSON.stringify({ questions: [question("7")] }))
      : new Response(JSON.stringify({ interaction: null, interactions: [] })),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={null} initialQuestions={[]} initialScreen="qa" />);
  act(() => void fake.emit("connect"));
  await waitFor(() => expect(screen.getByText("Question 7")).toBeTruthy());
  expect(fetchMock).toHaveBeenCalledWith("/api/events/e1/present/questions");
});

it("an arrow key leaves the Q&A screen and moves to the next interaction", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ interaction: null, interactions: [] })));
  vi.stubGlobal("fetch", fetchMock);
  render(
    <PresenterView
      eventId="e1"
      joinCode="1234"
      items={[{ id: "i1", state: "live" }, { id: "i2", state: "draft" }]}
      initial={state({ a: 0, b: 0 }, 0)}
      initialQuestions={[]}
      initialScreen="qa"
    />,
  );
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(screen.getByText("Total votes: 0")).toBeTruthy();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/events/e1/interactions/i2/start", { method: "POST" }));
});

it("ignores question messages for another Q&A of the event", () => {
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={null} initialQuestions={[question("1")]} initialQaId="qa1" initialScreen="qa" />);
  act(() => void fake.emit("question:added", { interactionId: "qa2", question: question("2") }));
  act(() => void fake.emit("question:removed", { interactionId: "qa2", questionId: "1" }));
  expect(screen.getByText("1 question")).toBeTruthy();
});

it("shows the live Q&A on the projector, under its own name, when no other interaction is live", () => {
  render(
    <PresenterView
      eventId="e1"
      joinCode="1234"
      items={[{ id: "qa1", state: "live", type: "qa", title: "Ask the board" }]}
      initial={null}
      initialQuestions={[question("1")]}
      initialQaId="qa1"
    />,
  );
  expect(screen.getByRole("heading", { name: "Ask the board" })).toBeTruthy();
  expect(screen.getByText("Question 1")).toBeTruthy();
});

const rankingState = (scores: [string, number, number][], total: number) => ({
  type: "ranking" as const,
  id: "r1",
  title: "Priorities",
  state: "live" as const,
  results: {
    interactionId: "r1",
    total,
    options: scores.map(([text, score, rank]) => ({ id: text, text, score, rank, positions: [] })),
  },
});

it("prints the rank and the score of each ranking option, best first", () => {
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={rankingState([["Speed", 9, 1], ["Cost", 9, 1], ["Look", 4, 3]], 3)} />);
  const rows = screen.getAllByRole("listitem").filter((li) => li.closest(".present-ranking"));
  expect(rows.map((li) => li.textContent)).toEqual(["#1 Speed9 points", "#1 Cost9 points", "#3 Look4 points"]);
  expect(screen.getByText("3 rankings submitted")).toBeTruthy();
});

it("re-sorts the ranking from ranking:results and ignores another interaction", () => {
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={rankingState([["Speed", 3, 1], ["Cost", 1, 2]], 1)} />);
  const next = (id: string) => ({
    results: { interactionId: id, total: 2, options: [
      { id: "Cost", text: "Cost", score: 5, rank: 1, positions: [] },
      { id: "Speed", text: "Speed", score: 4, rank: 2, positions: [] },
    ] },
  });
  act(() => {
    fake.emit("ranking:results", next("other"));
  });
  expect(screen.getByText("1 ranking submitted")).toBeTruthy();
  act(() => {
    fake.emit("ranking:results", next("r1"));
  });
  const rows = screen.getAllByRole("listitem").filter((li) => li.closest(".present-ranking"));
  expect(rows.map((li) => li.textContent)).toEqual(["#1 Cost5 points", "#2 Speed4 points"]);
});

const quizState = (over: Record<string, unknown> = {}) => ({
  type: "quiz" as const,
  id: "z1",
  title: "Quiz",
  state: "live" as const,
  prompt: "Which language runs in the browser?",
  options: [
    { id: "a", text: "JavaScript" },
    { id: "b", text: "COBOL" },
  ],
  timeLimitSeconds: 20,
  deadlineAt: 1_000_000 + 20_000,
  serverNow: 1_000_000,
  total: 0,
  results: null,
  ...over,
});

it("shows the live quiz question with seconds left, the answer count and no counts per option", () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(1_000_000);
  try {
    render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={quizState({ total: 3 })} />);
    expect(screen.getByText("Which language runs in the browser?")).toBeTruthy();
    expect(screen.getByText("20 seconds left")).toBeTruthy();
    expect(screen.getByText("3 answers")).toBeTruthy();
    expect(screen.getByText("JavaScript")).toBeTruthy();
    expect(screen.queryByText("Correct answer")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    // Shown on the bar and, at the 5 s step, announced to screen readers.
    expect(screen.getAllByText("5 seconds left").length).toBe(2);
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(screen.getAllByText("Time is up").length).toBeGreaterThan(0);
  } finally {
    vi.useRealTimers();
  }
});

it("updates the quiz answer count from quiz:results and ignores another question", () => {
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={quizState()} />);
  act(() => {
    fake.emit("quiz:results", { results: { interactionId: "other", total: 9, options: [] } });
  });
  expect(screen.getByText("0 answers")).toBeTruthy();
  act(() => {
    fake.emit("quiz:results", { results: { interactionId: "z1", total: 1, options: [] } });
  });
  expect(screen.getByText("1 answer")).toBeTruthy();
});

it("closes the live quiz question from the reveal button", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ interaction: {} })));
  vi.stubGlobal("fetch", fetchMock);
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={quizState()} />);
  fireEvent.click(screen.getByRole("button", { name: "Close and show answer" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/events/e1/interactions/z1/close", { method: "POST" }));
});

it("shows the correct options and the count per option once the quiz is closed", () => {
  const results = {
    interactionId: "z1",
    total: 3,
    correctPercent: 67,
    options: [
      { id: "a", text: "JavaScript", correct: true, count: 2 },
      { id: "b", text: "COBOL", correct: false, count: 1 },
    ],
  };
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={quizState({ state: "closed", deadlineAt: null, total: 3, results })} />);
  const rows = screen.getAllByRole("listitem").filter((li) => li.closest(".present-quiz-results"));
  expect(rows.map((li) => li.textContent)).toEqual(["JavaScriptCorrect answer2 answers", "COBOL1 answer"]);
  expect(screen.getByText(/3 answers, 67% correct \(closed\)/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Close and show answer" })).toBeNull();
});
