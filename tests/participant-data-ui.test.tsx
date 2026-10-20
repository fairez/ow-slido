import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParticipantData } from "@/components/participant-data";

const rows = [
  { id: "p1", name: "Ayu", joinedAt: "2030-01-01T10:00:00.000Z", contributions: 3 },
  { id: "p2", name: null, joinedAt: "2030-01-01T10:05:00.000Z", contributions: 1 },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stub(deleteStatus = 200) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      return deleteStatus === 200 ? Response.json({ ok: true, removed: 3 }) : Response.json({ error: "Nope" }, { status: deleteStatus });
    }
    return Response.json({ participants: rows, total: 2 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ParticipantData", () => {
  it("lists participants with a fallback name and asks before deleting", async () => {
    const fetchMock = stub();
    render(<ParticipantData eventId="e1" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete participant data" }));
    expect(await screen.findByText("Ayu")).toBeTruthy();
    expect(screen.getByText("Participant 2")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/events/e1/participants");

    fireEvent.click(screen.getByRole("button", { name: "Delete data of Ayu" }));
    expect(screen.getByRole("heading", { name: "Delete everything from Ayu?" })).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Delete everything from Ayu?");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Participant 2")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deletes the chosen participant and removes it from the list", async () => {
    const fetchMock = stub();
    render(<ParticipantData eventId="e1" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete participant data" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete data of Ayu" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete data" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Deleted the data of Ayu."));
    expect(screen.queryByText("Ayu")).toBeNull();
    expect(screen.getByText("Participant 1")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/events/e1/participants/p1/data", { method: "DELETE" });
  });

  it("stays on the confirmation and shows the error when the delete fails", async () => {
    stub(403);
    render(<ParticipantData eventId="e1" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete participant data" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete data of Ayu" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete data" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Nope");
    expect(screen.getByRole("heading", { name: "Delete everything from Ayu?" })).toBeTruthy();
  });
});
