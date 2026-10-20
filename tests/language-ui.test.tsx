import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AudienceLanguage } from "@/components/audience-language";
import { LanguageSettings } from "@/components/language-settings";
import { I18nProvider } from "@/lib/i18n/client";
import type { Locale } from "@/lib/i18n/locale";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));

afterEach(() => {
  cleanup();
  refresh.mockReset();
  vi.unstubAllGlobals();
  document.cookie = "lang_e1=; Max-Age=0; Path=/";
});

const inLocale = (locale: Locale, node: React.ReactNode) => render(<I18nProvider locale={locale}>{node}</I18nProvider>);

describe("AudienceLanguage", () => {
  it("shows both languages by their own names with the current one pressed", () => {
    inLocale("id", <AudienceLanguage eventId="e1" />);
    expect(screen.getByRole("group", { name: "Bahasa" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bahasa Indonesia" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "English" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("stores the choice in a cookie for this event and refreshes the page", () => {
    inLocale("id", <AudienceLanguage eventId="e1" />);
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(document.cookie).toContain("lang_e1=en");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the current language is chosen again", () => {
    inLocale("en", <AudienceLanguage eventId="e1" />);
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(document.cookie).not.toContain("lang_e1");
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("LanguageSettings", () => {
  it("saves the chosen language through the account route and refreshes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ locale: "id" }));
    vi.stubGlobal("fetch", fetchMock);
    inLocale("en", <LanguageSettings />);
    expect((screen.getByRole("radio", { name: "English" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Bahasa Indonesia" }));
    fireEvent.click(screen.getByRole("button", { name: "Save language" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Language saved."));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/locale", expect.objectContaining({ method: "PUT", body: JSON.stringify({ locale: "id" }) }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows the server's message when saving fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Nope" }, { status: 400 })));
    inLocale("en", <LanguageSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Save language" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Nope"));
    expect(refresh).not.toHaveBeenCalled();
  });
});
