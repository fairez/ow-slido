import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLog, type AuditEntry, type AuditPageData } from "@/components/audit-log";
import { I18nProvider } from "@/lib/i18n/client";

const entry = (n: number, over: Partial<AuditEntry> = {}): AuditEntry => ({
  id: `e${n}`,
  actorLabel: "ana@example.com",
  action: "member.role_changed",
  targetType: "membership",
  targetId: "m1",
  metadata: { from: "editor", to: "admin" },
  ip: "203.0.113.9",
  createdAt: "2026-10-01T08:30:00.000Z",
  ...over,
});
const page = (entries: AuditEntry[], over: Partial<AuditPageData> = {}): AuditPageData => ({ entries, total: entries.length, page: 1, pageSize: 50, ...over });

function ui(initial: AuditPageData, actions = ["auth.login", "member.role_changed"]) {
  return render(
    <I18nProvider locale="en">
      <AuditLog initial={initial} actions={actions} />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AuditLog", () => {
  it("shows the time in the viewer's zone with the UTC value in text and on hover", () => {
    ui(page([entry(1)]));
    const time = document.querySelector("time") as HTMLTimeElement;
    expect(time.getAttribute("datetime")).toBe("2026-10-01T08:30:00.000Z");
    expect(time.title).toMatch(/8:30:00\sAM UTC$/);
    expect(screen.getAllByText(/8:30:00\sAM UTC$/).length).toBeGreaterThan(0);
    expect(document.querySelector(".audit-action")?.textContent).toBe("member.role_changed");
    expect(screen.getByText("By ana@example.com")).toBeTruthy();
    expect(screen.getByText("from: editor, to: admin")).toBeTruthy();
  });

  it("says so when there are no entries and when filters match none", async () => {
    ui(page([], { total: 0 }));
    expect(screen.getByText("No entries yet")).toBeTruthy();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(page([], { total: 0 }))));
    fireEvent.change(screen.getByLabelText("Actor"), { target: { value: "zed" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => expect(screen.getByText("No entries match")).toBeTruthy());
  });

  it("sends the filters as a query, with dates as local-day instants", async () => {
    const fetchMock = vi.fn(async () => Response.json(page([entry(2)])));
    vi.stubGlobal("fetch", fetchMock);
    ui(page([entry(1)]));
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "auth.login" } });
    fireEvent.change(screen.getByLabelText(/^Actor/), { target: { value: " ana " } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-10-02" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]), "http://x");
    expect(url.pathname).toBe("/api/audit");
    expect(url.searchParams.get("action")).toBe("auth.login");
    expect(url.searchParams.get("actor")).toBe("ana");
    expect(url.searchParams.get("from")).toBe(new Date(2026, 9, 1).toISOString());
    expect(url.searchParams.get("to")).toBe(new Date(2026, 9, 3).toISOString());
  });

  it("refuses a range that ends before it starts", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    ui(page([entry(1)]));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-05" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-10-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(screen.getByRole("alert").textContent).toBe("The start date must be before the end date.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pages with Previous and Next, keeping the applied filters", async () => {
    const fetchMock = vi.fn(async () => Response.json(page([entry(51)], { total: 120, page: 2 })));
    vi.stubGlobal("fetch", fetchMock);
    ui(page([entry(1)], { total: 120 }));
    const nav = screen.getByRole("navigation", { name: "Pages" });
    expect(within(nav).getByText("Page 1 of 3")).toBeTruthy();
    expect(within(nav).getByRole("button", { name: "Previous" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(within(nav).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "Pages" })).getByText("Page 2 of 3")).toBeTruthy());
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("/api/audit?page=2");
    expect(screen.getByText(/Showing 51-51 of 120/)).toBeTruthy();
  });

  it("shows the server's message when loading fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Nope" }, { status: 500 })));
    ui(page([entry(1)]));
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Nope"));
  });
});
