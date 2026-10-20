import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PollManager, type InteractionItem } from "@/components/poll-manager";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const survey: InteractionItem = {
  id: "s1",
  type: "survey",
  title: "Feedback",
  state: "draft",
  position: 0,
  config: {
    questions: [
      { id: "qa", kind: "choice", text: "Which session?", required: true, multiple: true, options: [{ id: "o1", text: "Morning" }, { id: "o2", text: "Evening" }] },
      { id: "qb", kind: "rating", text: "How was it?", required: false, scale: "numeric10" },
      { id: "qc", kind: "openText", text: "Anything else?", required: false },
    ],
  },
};

const open = () => {
  fireEvent.click(screen.getByRole("button", { name: "Add content" }));
  fireEvent.click(screen.getByRole("button", { name: "New survey" }));
};
const bodyOf = (fetchMock: ReturnType<typeof vi.fn>) => JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);

describe("survey builder", () => {
  it("builds a survey with the three kinds, required marks, options and scale", async () => {
    const created: InteractionItem = { ...survey, id: "s2", title: "Pulse" };
    const fetchMock = vi.fn(async () => Response.json({ interaction: created }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PollManager eventId="e" initialInteractions={[]} />);
    open();
    fireEvent.change(screen.getByLabelText("Survey name"), { target: { value: "Pulse" } });
    fireEvent.change(screen.getByLabelText("Question text"), { target: { value: "Pick one" } });
    fireEvent.change(screen.getByLabelText("Option 1 of question 1"), { target: { value: "A" } });
    fireEvent.change(screen.getByLabelText("Option 2 of question 1"), { target: { value: "B" } });
    fireEvent.click(screen.getByRole("button", { name: "Add option to question 1" }));
    fireEvent.change(screen.getByLabelText("Option 3 of question 1"), { target: { value: "C" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove option 3 of question 1" }));
    fireEvent.click(screen.getByLabelText("Allow several answers"));
    fireEvent.click(screen.getByLabelText("Required"));

    fireEvent.click(screen.getByRole("button", { name: "Add question" }));
    const second = screen.getByRole("group", { name: "Question 2" });
    fireEvent.change(within(second).getByLabelText("Answer type"), { target: { value: "rating" } });
    fireEvent.change(within(second).getByLabelText("Question text"), { target: { value: "Rate it" } });
    fireEvent.click(within(second).getByLabelText("Numbers, 1 to 10"));

    fireEvent.click(screen.getByRole("button", { name: "Add question" }));
    const third = screen.getByRole("group", { name: "Question 3" });
    fireEvent.change(within(third).getByLabelText("Answer type"), { target: { value: "openText" } });
    fireEvent.change(within(third).getByLabelText("Question text"), { target: { value: "Why?" } });

    fireEvent.click(screen.getByRole("button", { name: "Save survey" }));
    await waitFor(() => expect(screen.getByText("Pulse")).toBeTruthy());
    const body = bodyOf(fetchMock);
    expect(body).toMatchObject({ type: "survey", title: "Pulse" });
    expect(body.questions).toHaveLength(3);
    expect(body.questions[0]).toMatchObject({ kind: "choice", text: "Pick one", required: true, multiple: true });
    expect(body.questions[0].options.map((o: { text: string }) => o.text)).toEqual(["A", "B"]);
    expect(body.questions[1]).toMatchObject({ kind: "rating", scale: "numeric10", required: false });
    expect(body.questions[1].options).toBeUndefined();
    expect(body.questions[2]).toMatchObject({ kind: "openText", text: "Why?" });
    expect(new Set(body.questions.map((q: { id: string }) => q.id)).size).toBe(3);
  });

  it("starts with one question, keeps at least one and at most twenty", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<PollManager eventId="e" initialInteractions={[]} />);
    open();
    expect((screen.getByRole("button", { name: "Remove question 1" }) as HTMLButtonElement).disabled).toBe(true);
    for (let i = 0; i < 19; i++) fireEvent.click(screen.getByRole("button", { name: "Add question" }));
    expect(screen.getByTestId("survey-count").textContent).toBe("20 of 20 questions");
    expect((screen.getByRole("button", { name: "Add question" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("moves a question with its buttons and keeps focus on the pressed button", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<PollManager eventId="e" initialInteractions={[survey]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const texts = () => screen.getAllByLabelText("Question text").map((el) => (el as HTMLTextAreaElement).value);
    expect(texts()).toEqual(["Which session?", "How was it?", "Anything else?"]);
    expect(screen.getByRole("button", { name: "Move question 1 up" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Move question 1 down" }));
    expect(texts()).toEqual(["How was it?", "Which session?", "Anything else?"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move question 2 down" }));
    expect(screen.getByRole("status").textContent).toBe("Question moved to position 2 of 3");
    fireEvent.click(screen.getByRole("button", { name: "Move question 3 up" }));
    expect(texts()).toEqual(["How was it?", "Anything else?", "Which session?"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move question 2 up" }));
    fireEvent.click(screen.getByRole("button", { name: "Move question 1 up" }));
    expect(texts()[0]).toBe("How was it?");
  });

  it("edits a draft survey, restating the ids it was given", async () => {
    const fetchMock = vi.fn(async () => Response.json({ interaction: { ...survey, title: "Feedback 2" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PollManager eventId="e" initialInteractions={[survey]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("Survey name") as HTMLInputElement).value).toBe("Feedback");
    expect((screen.getByLabelText("Allow several answers") as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText("Survey name"), { target: { value: "Feedback 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save survey" }));
    await waitFor(() => expect(screen.getByText("Feedback 2")).toBeTruthy());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/events/e/interactions/s1");
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body as string);
    expect(body.questions.map((q: { id: string }) => q.id)).toEqual(["qa", "qb", "qc"]);
    expect(body.questions[0].options.map((o: { id: string }) => o.id)).toEqual(["o1", "o2"]);
  });

  it("shows the server's error and keeps the form", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Every question needs text" }, { status: 400 })));
    render(<PollManager eventId="e" initialInteractions={[survey]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save survey" }));
    await waitFor(() => expect(screen.getByText("Every question needs text")).toBeTruthy());
    expect(screen.getByLabelText("Survey name")).toBeTruthy();
  });

  it("previews what participants see without sending anything", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<PollManager eventId="e" initialInteractions={[survey]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const toggle = screen.getByRole("button", { name: "Show preview" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const preview = screen.getByRole("region", { name: "Preview" });
    expect(within(preview).getByText("Which session?")).toBeTruthy();
    expect(within(preview).getByText(/Choose any that apply/)).toBeTruthy();
    expect(within(preview).getAllByRole("checkbox")).toHaveLength(2);
    expect(within(preview).getByRole("img", { name: "Rating, 1 to 10" })).toBeTruthy();
    expect(within(preview).getByRole("textbox", { name: "Your answer" })).toBeTruthy();
    expect((within(preview).getByRole("button", { name: "Send answers" }).closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Survey name"), { target: { value: "New name" } });
    expect(within(screen.getByRole("region", { name: "Preview" })).getByRole("heading", { name: "New name" })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Hide preview" }));
    expect(screen.queryByRole("region", { name: "Preview" })).toBeNull();
  });

  it("warns before leaving with unsaved changes, not without", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<PollManager eventId="e" initialInteractions={[survey]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Survey name"), { target: { value: "Changed" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Discard unsaved changes?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect((screen.getByLabelText("Survey name") as HTMLInputElement).value).toBe("Changed");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByLabelText("Survey name")).toBeNull();
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("asks before following a link with unsaved changes", () => {
    vi.stubGlobal("fetch", vi.fn());
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const followed = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(
      <>
        <a href="/dashboard" onClick={followed}>Dashboard</a>
        <PollManager eventId="e" initialInteractions={[]} />
      </>,
    );
    open();
    const link = screen.getByRole("link", { name: "Dashboard" });
    fireEvent.click(link);
    expect(confirm).not.toHaveBeenCalled();
    expect(followed).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("Survey name"), { target: { value: "x" } });
    fireEvent.click(link);
    expect(confirm).toHaveBeenCalledWith("You have unsaved changes to a survey. Leave this page?");
    expect(followed).toHaveBeenCalledTimes(1);
    confirm.mockReturnValue(true);
    fireEvent.click(link);
    expect(followed).toHaveBeenCalledTimes(2);
  });

  it("renames a draft survey through its title", async () => {
    const fetchMock = vi.fn(async () => Response.json({ interaction: { ...survey, title: "Renamed" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PollManager eventId="e" initialInteractions={[survey]} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock)).toEqual({ title: "Renamed" });
  });
});
