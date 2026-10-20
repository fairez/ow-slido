import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SurveyForm } from "@/components/survey-form";
import type { SurveyPageData } from "@/lib/survey-page";

const open = (extra: Partial<Extract<SurveyPageData, { status: "open" }>> = {}): SurveyPageData => ({
  status: "open",
  id: "s1",
  title: "Feedback",
  eventName: "Launch day",
  submitted: false,
  questions: [
    {
      id: "q1",
      kind: "choice",
      text: "Favourite colour",
      required: true,
      multiple: false,
      options: [
        { id: "r", text: "Red" },
        { id: "g", text: "Green" },
      ],
    },
    { id: "q2", kind: "rating", text: "How good was it", required: true, scale: "stars5" },
    { id: "q3", kind: "openText", text: "Anything else", required: false },
  ],
  ...extra,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let fetchMock: ReturnType<typeof vi.fn>;
const calls = (suffix: string) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix));

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => (String(url).endsWith("/join") ? json({ submitted: false }) : json({ ok: true }, 201)));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("joins on arrival and shows progress and required markers", async () => {
  render(<SurveyForm survey={open()} />);
  await waitFor(() => expect(calls("/api/interactions/s1/survey/join")).toHaveLength(1));
  expect(screen.getByRole("heading", { name: "Feedback" })).toBeTruthy();
  expect(screen.getByText("0 of 3 answered")).toBeTruthy();
  expect(screen.getAllByText(/^Required/)).toHaveLength(2);
  expect(screen.getByText("Optional")).toBeTruthy();

  fireEvent.click(screen.getByLabelText("Green"));
  expect(screen.getByText("1 of 3 answered")).toBeTruthy();
  expect(screen.getByRole("progressbar", { name: "Questions answered" }).getAttribute("value")).toBe("1");
});

it("blocks sending, names every unanswered required question and focuses the first", async () => {
  render(<SurveyForm survey={open()} />);
  fireEvent.click(screen.getByRole("button", { name: "Send answers" }));

  expect(screen.getAllByText("Answer this question to continue.")).toHaveLength(2);
  expect(screen.getByRole("alert").textContent).toBe("2 required questions have no answer.");
  expect(document.activeElement).toBe(screen.getAllByRole("radio")[0]);
  expect(calls("/api/interactions/s1/survey")).toHaveLength(0);

  // Answering a question clears its message.
  fireEvent.click(screen.getByLabelText("Red"));
  expect(screen.getAllByText("Answer this question to continue.")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
  expect(document.activeElement).toBe(screen.getByLabelText("1 star"));

  fireEvent.click(screen.getByLabelText("3 stars"));
  expect(screen.queryByText("Answer this question to continue.")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("sends only the answered questions and thanks the participant", async () => {
  render(<SurveyForm survey={open()} />);
  fireEvent.click(screen.getByLabelText("Red"));
  fireEvent.click(screen.getByLabelText("4 stars"));
  fireEvent.click(screen.getByRole("button", { name: "Send answers" }));

  await screen.findByText("Thank you");
  const [, init] = calls("/api/interactions/s1/survey")[0];
  expect(JSON.parse(init.body)).toEqual({ answers: { q1: ["r"], q2: 4 } });
});

it("shows 'Already submitted' when the server says this participant has sent it", async () => {
  fetchMock.mockImplementation(async (url: string) =>
    String(url).endsWith("/join") ? json({ submitted: false }) : json({ error: "Already submitted", reason: "alreadySubmitted" }, 409),
  );
  render(<SurveyForm survey={open()} />);
  fireEvent.click(screen.getByLabelText("Red"));
  fireEvent.click(screen.getByLabelText("5 stars"));
  fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
  await screen.findByText("Already submitted");
});

it("shows 'Already submitted' straight away for a returning participant, without joining again", () => {
  render(<SurveyForm survey={open({ submitted: true })} />);
  expect(screen.getByText("Already submitted")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send answers" })).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("shows 'Already submitted' when the join reply says so", async () => {
  fetchMock.mockImplementation(async () => json({ submitted: true }));
  render(<SurveyForm survey={open()} />);
  await screen.findByText("Already submitted");
});

it("shows a closed message and a not-open message instead of the form", () => {
  render(<SurveyForm survey={{ status: "closed", id: "s1", title: "Feedback", eventName: "Launch day" }} />);
  expect(screen.getByText("This survey is closed")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send answers" })).toBeNull();
  cleanup();
  render(<SurveyForm survey={{ status: "notOpen", id: "s1", title: "Feedback", eventName: "Launch day" }} />);
  expect(screen.getByText("This survey is not open yet")).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("reports a server-side missing list the same way", async () => {
  fetchMock.mockImplementation(async (url: string) =>
    String(url).endsWith("/join") ? json({ submitted: false }) : json({ error: "x", questionId: "q2", missing: ["q2"] }, 400),
  );
  render(<SurveyForm survey={open()} />);
  fireEvent.click(screen.getByLabelText("Red"));
  fireEvent.click(screen.getByLabelText("5 stars"));
  fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("1 required question has no answer."));
  expect(document.activeElement).toBe(screen.getByLabelText("1 star"));
});

it("shows the join error and retries the join on send", async () => {
  fetchMock.mockImplementationOnce(async () => json({ error: "This event is full." }, 403));
  render(<SurveyForm survey={open()} />);
  await screen.findByText("This event is full.");
  fireEvent.click(screen.getByLabelText("Red"));
  fireEvent.click(screen.getByLabelText("5 stars"));
  fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
  await screen.findByText("Thank you");
  expect(calls("/join")).toHaveLength(2);
});
