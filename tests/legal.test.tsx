import { cleanup, render, screen, within } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { t as translate, type Locale } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import { id } from "@/lib/i18n/id";
import { TERMS_SECTIONS } from "@/lib/legal";
import { RETENTION_NOTICE_DAYS, RETENTION_OPTIONS } from "@/lib/retention-schedule";

let locale: Locale = "en";
vi.mock("@/lib/i18n/server", () => ({
  getLocale: async () => locale,
  getT: async () => (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate(locale, key, params),
}));

import PrivacyPage from "@/app/privacy/page";
import TermsPage from "@/app/terms/page";
import { LegalLinks } from "@/components/legal-links";

afterEach(() => {
  cleanup();
  locale = "en";
});

const REVIEWED = path.join(process.cwd(), "docs/legal/REVIEWED");
const PAGES = [
  ["terms", TermsPage],
  ["privacy", PrivacyPage],
] as const;

async function renderPage(Page: typeof TermsPage, lang: Locale) {
  locale = lang;
  render(<I18nProvider locale={lang}>{await Page()}</I18nProvider>);
}

describe("placeholder banner", () => {
  it.each(PAGES)("stays on /%s until docs/legal/REVIEWED exists", async (_name, Page) => {
    await renderPage(Page, "en");
    const banner = document.querySelector("[data-legal-placeholder]");
    if (existsSync(REVIEWED)) return;
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toContain("Placeholder text, supplied by the project owner");
  });

  it.each(PAGES)("is shown in Indonesian on /%s", async (_name, Page) => {
    await renderPage(Page, "id");
    if (existsSync(REVIEWED)) return;
    expect(document.querySelector("[data-legal-placeholder]")?.textContent).toContain(translate("id", "legal.banner"));
  });

  it("is rendered by the shared component, so one removal is caught on both pages", () => {
    if (existsSync(REVIEWED)) return;
    expect(readFileSync(path.join(process.cwd(), "components/legal-page.tsx"), "utf8")).toContain("data-legal-placeholder");
  });
});

describe("pages", () => {
  it.each(["en", "id"] as const)("terms has a heading and every section in %s", async (lang) => {
    await renderPage(TermsPage, lang);
    expect(screen.getByRole("heading", { level: 1, name: translate(lang, "legal.terms.title") })).toBeTruthy();
    for (const section of TERMS_SECTIONS) {
      expect(screen.getByRole("heading", { level: 2, name: translate(lang, section.heading) })).toBeTruthy();
    }
  });

  it("privacy covers storage, AI analysis, deletion and retention in plain words", async () => {
    await renderPage(PrivacyPage, "en");
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/What is stored/);
    expect(text).toMatch(/approved notes is sent to a third-party AI service/);
    expect(text).toMatch(/Nothing is sent unless a host starts the analysis/);
    expect(text).toMatch(/delete one participant's data/);
    expect(text).toMatch(/How long data is kept/);
  });

  it.each(["en", "id"] as const)("privacy retention periods come from the retention setting (%s)", async (lang) => {
    await renderPage(PrivacyPage, lang);
    const section = screen.getByRole("heading", { level: 2, name: translate(lang, "legal.privacy.keep.h") }).closest("section")!;
    for (const days of RETENTION_OPTIONS) expect(section.textContent).toContain(String(days));
    expect(section.textContent).toContain(String(RETENTION_NOTICE_DAYS));
    expect(section.textContent).not.toMatch(/\{(days|notice)\}/);
  });
});

describe("links", () => {
  it("LegalLinks points to /terms and /privacy", () => {
    render(
      <I18nProvider locale="id">
        <LegalLinks />
      </I18nProvider>,
    );
    const nav = screen.getByRole("navigation", { name: "Hukum" });
    expect(within(nav).getByRole("link", { name: "Ketentuan" }).getAttribute("href")).toBe("/terms");
    expect(within(nav).getByRole("link", { name: "Privasi" }).getAttribute("href")).toBe("/privacy");
  });

  // The footer shows on sign-up and the home page; audience pages hide it, so they carry LegalLinks.
  it.each([
    ["components/ui/app-shell.tsx", /href="\/terms"[\s\S]*href="\/privacy"/],
    ["components/join-redirect.tsx", /LegalLinks/],
    ["app/e/[eventId]/page.tsx", /LegalLinks/],
    ["app/survey/[id]/page.tsx", /LegalLinks/],
  ])("%s links to the legal pages", (file, pattern) => {
    expect(readFileSync(path.join(process.cwd(), file), "utf8")).toMatch(pattern);
  });
});

describe("Indonesian copy", () => {
  const keys = (Object.keys(en) as (keyof typeof en)[]).filter((k) => k.startsWith("legal."));
  const placeholders = (s: string) => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort();

  it("has every key", () => {
    expect(keys.length).toBeGreaterThan(30);
    for (const k of keys) expect(id[k], k).toBeTruthy();
  });

  it("is not a copy of the English text", () => {
    const same = keys.filter((k) => id[k] === en[k]);
    expect(same).toEqual([]);
  });

  it("keeps the placeholders", () => {
    for (const k of keys) expect(placeholders(id[k]), k).toEqual(placeholders(en[k]));
  });
});
