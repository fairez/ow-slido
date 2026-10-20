import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventManager } from "@/components/event-manager";
import { PollManager, type InteractionItem } from "@/components/poll-manager";
import { TemplatesManager } from "@/components/templates-manager";
import type { TemplateSummary } from "@/components/template-types";

vi.mock("@/lib/realtime/use-event-socket", () => ({ useEventSocket: () => ({ socket: null }) }));

const poll = (id: string, title: string): InteractionItem => ({
  id,
  type: "poll",
  title,
  state: "draft",
  position: 0,
  config: { options: [{ id: "o1", label: "A" }, { id: "o2", label: "B" }] },
});

const template = (id: string, name: string, kind: TemplateSummary["kind"] = "event"): TemplateSummary => ({
  id,
  name,
  kind,
  items: [
    { type: "poll", title: "Favourite colour?" },
    { type: "qa", title: "Q&A" },
  ],
});

const reply = (body: unknown, status = 200) => Response.json(body, { status });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Save as template", () => {
  it("saves one item under a name the host can change", async () => {
    const fetchMock = vi.fn(async () => reply({ template: { id: "t1", name: "Colour poll" } }, 201));
    vi.stubGlobal("fetch", fetchMock);
    render(<PollManager eventId="e1" initialInteractions={[poll("p1", "Favourite colour?")]} canManageTemplates eventName="Kickoff" />);
    fireEvent.click(screen.getByRole("button", { name: "Save Favourite colour? as a template" }));
    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByLabelText("Template name") as HTMLInputElement).value).toBe("Favourite colour?");
    fireEvent.change(within(dialog).getByLabelText("Template name"), { target: { value: "Colour poll" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Saved as template Colour poll."));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/templates",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ eventId: "e1", interactionId: "p1", name: "Colour poll" }) }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("link", { name: "View templates" }).getAttribute("href")).toBe("/dashboard/templates");
  });

  it("saves the whole event without an interaction id", async () => {
    const fetchMock = vi.fn(async () => reply({ template: { id: "t1", name: "Kickoff" } }, 201));
    vi.stubGlobal("fetch", fetchMock);
    render(<PollManager eventId="e1" initialInteractions={[poll("p1", "Q")]} canManageTemplates eventName="Kickoff" />);
    fireEvent.click(screen.getByRole("button", { name: "Save event as template" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ eventId: "e1", name: "Kickoff" });
  });

  it("shows the limit error with the plan hint and keeps the dialog open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply({ error: "Your plan allows 3 templates and they are all used.", reason: "template_limit", requiredPlan: "pro" }, 402)),
    );
    render(<PollManager eventId="e1" initialInteractions={[poll("p1", "Q")]} canManageTemplates eventName="Kickoff" />);
    fireEvent.click(screen.getByRole("button", { name: "Save event as template" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toContain("all used"));
    const hint = within(dialog).getByRole("link", { name: /More templates/ });
    expect(hint.getAttribute("href")).toBe("/dashboard/plan");
    expect(hint.textContent).toContain("Pro plan");
  });

  it("hides the save controls from members who cannot manage templates", () => {
    render(<PollManager eventId="e1" initialInteractions={[poll("p1", "Q")]} eventName="Kickoff" />);
    expect(screen.queryByRole("button", { name: /Save .* as a template/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save event as template" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add from template" })).toBeTruthy();
  });
});

describe("Add from template", () => {
  it("lists the templates and adds the chosen one to the list", async () => {
    const added: InteractionItem[] = [poll("n1", "Favourite colour?")];
    const fetchMock = vi.fn(async (url: string) =>
      url === "/api/templates" ? reply({ templates: [template("t1", "Kickoff")], usage: { used: 1, limit: 3 } }) : reply({ interactions: added }, 201),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<PollManager eventId="e1" initialInteractions={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add from template" }));
    const dialog = screen.getByRole("dialog");
    await within(dialog).findByText("Kickoff");
    expect(within(dialog).getByRole("list", { name: "Items in Kickoff" }).textContent).toContain("Favourite colour?");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Kickoff to this event" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith("/api/events/e1/interactions/from-template", expect.objectContaining({ body: JSON.stringify({ templateId: "t1" }) }));
    expect(screen.getByRole("heading", { name: "Favourite colour?" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Added Kickoff to this event.");
  });

  it("explains an empty workspace", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ templates: [], usage: { used: 0, limit: 3 } })));
    render(<PollManager eventId="e1" initialInteractions={[]} canManageTemplates />);
    fireEvent.click(screen.getByRole("button", { name: "Add from template" }));
    expect((await within(screen.getByRole("dialog")).findByText(/no templates yet/)).textContent).toContain("Use Save as template");
  });

  it("shows a plan error and adds nothing when a type is not in the plan", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/templates"
          ? reply({ templates: [template("t1", "Kickoff")], usage: { used: 1, limit: 3 } })
          : reply({ error: "Rating is not part of the Free plan.", reason: "type_not_allowed", requiredPlan: "pro" }, 402),
      ),
    );
    render(<PollManager eventId="e1" initialInteractions={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add from template" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Add Kickoff to this event" }));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toContain("not part of the Free plan"));
    expect(within(dialog).getByRole("link", { name: /Unlock/ }).textContent).toContain("Pro plan");
    expect(screen.queryByRole("listitem", { name: /./ })).toBeNull();
  });
});

describe("TemplatesManager", () => {
  it("shows the count against the limit and the items of each template", () => {
    render(<TemplatesManager initialTemplates={[template("t1", "Kickoff")]} limit={3} canManage />);
    expect(screen.getByTestId("template-usage").textContent).toBe("1 of 3 templates used");
    expect(screen.getByText("2 items")).toBeTruthy();
    expect(screen.getByText("Whole event")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /More templates/ })).toBeNull();
  });

  it("points to the plan page once every slot is used", () => {
    render(<TemplatesManager initialTemplates={[template("t1", "A"), template("t2", "B")]} limit={2} canManage limitLock={{ requiredPlan: "team" }} />);
    expect(screen.getByRole("link", { name: /More templates/ }).textContent).toContain("Team plan");
  });

  it("renames through PATCH", async () => {
    const fetchMock = vi.fn(async () => reply({ template: { id: "t1", name: "Town hall" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<TemplatesManager initialTemplates={[template("t1", "Kickoff")]} limit={3} canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Rename Kickoff" }));
    fireEvent.change(screen.getByLabelText("Template name"), { target: { value: "Town hall" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Town hall" })).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith("/api/templates/t1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Town hall" }) }));
  });

  it("deletes after a confirmation and frees the slot", async () => {
    const fetchMock = vi.fn(async () => reply({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(<TemplatesManager initialTemplates={[template("t1", "Kickoff")]} limit={3} canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Kickoff" }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete template" }));
    await waitFor(() => expect(screen.getByText("No templates yet")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith("/api/templates/t1", expect.objectContaining({ method: "DELETE" }));
    expect(screen.getByTestId("template-usage").textContent).toBe("0 of 3 templates used");
  });

  it("shows a server error and keeps the template", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ error: "Template not found" }, 404)));
    render(<TemplatesManager initialTemplates={[template("t1", "Kickoff")]} limit={3} canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Kickoff" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete template" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Template not found"));
    expect(screen.getByRole("heading", { name: "Kickoff" })).toBeTruthy();
  });

  it("is read-only for members who cannot manage templates", () => {
    render(<TemplatesManager initialTemplates={[template("t1", "Kickoff")]} limit={3} canManage={false} />);
    expect(screen.queryByRole("button", { name: /Rename|Delete/ })).toBeNull();
    expect(screen.getByText(/Only owners and admins/)).toBeTruthy();
  });
});

describe("New event from a template", () => {
  const fill = () => {
    fireEvent.change(screen.getByLabelText("Event name"), { target: { value: "Spring kickoff" } });
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-11-01T09:00" } });
    fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-11-01T10:00" } });
  };
  const saved = { id: "ev1", name: "Spring kickoff", startsAt: "2026-11-01T01:00:00.000Z", endsAt: "2026-11-01T02:00:00.000Z", joinCode: "1234" };

  it("has no template choice when the workspace has none", () => {
    render(<EventManager initialEvents={[]} />);
    expect(screen.queryByLabelText("Template")).toBeNull();
  });

  it("creates through the template route and reports skipped items", async () => {
    const fetchMock = vi.fn(async () => reply({ event: saved, skipped: 2 }, 201));
    vi.stubGlobal("fetch", fetchMock);
    render(<EventManager initialEvents={[]} templates={[{ id: "t1", name: "Kickoff", itemCount: 3 }]} />);
    fill();
    fireEvent.change(screen.getByLabelText("Template"), { target: { value: "t1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));
    await waitFor(() => expect(screen.getByText(/2 items were left out/)).toBeTruthy());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/events/from-template");
    expect(JSON.parse(init.body as string)).toMatchObject({ name: "Spring kickoff", templateId: "t1" });
  });

  it("uses the plain route when 'Blank event' stays selected", async () => {
    const fetchMock = vi.fn(async () => reply({ event: saved }, 201));
    vi.stubGlobal("fetch", fetchMock);
    render(<EventManager initialEvents={[]} templates={[{ id: "t1", name: "Kickoff", itemCount: 3 }]} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/events");
    expect(JSON.parse(init.body as string)).not.toHaveProperty("templateId");
  });

  it("shows the monthly event limit with the plan hint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ error: "You have used this month's events.", reason: "event_limit", requiredPlan: "pro" }, 402)));
    render(<EventManager initialEvents={[]} templates={[{ id: "t1", name: "Kickoff", itemCount: 3 }]} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("this month's events"));
    expect(screen.getByRole("link", { name: /More events/ }).textContent).toContain("Pro plan");
  });
});
