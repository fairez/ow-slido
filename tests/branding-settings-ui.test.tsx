import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrandingSettings } from "@/components/branding-settings";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const field = () => screen.getByLabelText("Accent colour") as HTMLInputElement;
const type = (value: string) => fireEvent.change(field(), { target: { value } });

describe("BrandingSettings", () => {
  it("previews both themes and reports a passing colour", () => {
    render(<BrandingSettings initial={null} />);
    expect(screen.queryByText("Light theme")).toBeNull();
    type("#1f6f5c");
    expect(screen.getByText("Light theme")).toBeTruthy();
    expect(screen.getByText("Dark theme")).toBeTruthy();
    expect(screen.getByText(/All six contrast checks pass/)).toBeTruthy();
    expect(screen.getAllByText(/:1 passes/)).toHaveLength(6);
  });

  it("names the failing pair and does not send a colour that fails", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<BrandingSettings initial={null} />);
    type("#f4d35e");
    expect(screen.getByText(/is too light or too dark/)).toBeTruthy();
    expect(screen.getAllByText(/:1 fails/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Apply colour" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks for a hex code when the text is not a colour", () => {
    render(<BrandingSettings initial={null} />);
    type("teal");
    expect(screen.getByText("Enter a colour as a hex code, for example #1f6f5c.")).toBeTruthy();
    expect(field().getAttribute("aria-invalid")).toBe("true");
  });

  it("saves the normalised colour and confirms", async () => {
    const fetchMock = vi.fn(async () => Response.json({ accent: "#1f6f5c" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<BrandingSettings initial={null} />);
    type("#1F6F5C");
    fireEvent.click(screen.getByRole("button", { name: "Apply colour" }));
    await waitFor(() => expect(screen.getByText(/Colour applied/)).toBeTruthy());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/workspaces/active/branding");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ accent: "#1f6f5c" });
    expect(screen.getByText("Current colour: #1f6f5c")).toBeTruthy();
  });

  it("removes the colour with null and goes back to the default", async () => {
    const fetchMock = vi.fn(async () => Response.json({ accent: null }));
    vi.stubGlobal("fetch", fetchMock);
    render(<BrandingSettings initial="#1f6f5c" />);
    fireEvent.click(screen.getByRole("button", { name: "Remove colour" }));
    await waitFor(() => expect(screen.getByText(/Colour removed/)).toBeTruthy());
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ accent: null });
    expect(screen.getByText(/No colour set/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove colour" })).toBeNull();
    expect(field().value).toBe("");
  });

  it("shows the server's error and the tier link on a plan limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Your plan does not include branding.", requiredPlan: "team" }, { status: 402 })));
    render(<BrandingSettings initial={null} />);
    type("#1f6f5c");
    fireEvent.click(screen.getByRole("button", { name: "Apply colour" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Your plan does not include branding."));
    expect(screen.getByRole("link", { name: /Set a brand colour/ }).getAttribute("href")).toBe("/dashboard/plan");
  });

  it("without the plan shows a link to the plan page instead of the form, and still lets a stored colour go", () => {
    render(<BrandingSettings initial="#1f6f5c" lock={{ requiredPlan: "team" }} />);
    expect(screen.queryByLabelText("Accent colour")).toBeNull();
    expect(screen.getByRole("link", { name: /Set a brand colour/ }).getAttribute("href")).toBe("/dashboard/plan");
    expect(screen.getByText(/not shown, because your plan no longer includes branding/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove colour" })).toBeTruthy();
  });
});
