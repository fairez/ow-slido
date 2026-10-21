import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { t as translate, type Locale } from "@/lib/i18n";
import { buildPricing } from "@/lib/pricing";
import { PLAN_IDS, PLAN_PRICES, PLANS } from "@/lib/plans";

let locale: Locale = "en";
vi.mock("@/lib/i18n/server", () => ({
  getLocale: async () => locale,
  getT: async () => (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate(locale, key, params),
}));

import PricingPage from "@/app/pricing/page";

afterEach(() => {
  cleanup();
  locale = "en";
});

async function renderPage(lang: Locale = "en") {
  locale = lang;
  render(<I18nProvider locale={lang}>{await PricingPage()}</I18nProvider>);
}

const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

it("lists every tier with its limits from lib/plans.ts and a sign-up link", async () => {
  await renderPage();
  expect(screen.getByRole("heading", { level: 1, name: "Plans and prices" })).toBeTruthy();
  const tiers = screen.getAllByRole("listitem").filter((li) => li.classList.contains("pricing-tier"));
  expect(tiers).toHaveLength(PLAN_IDS.length);
  const [free, pro, team] = tiers;
  expect(within(free).getByRole("heading", { name: "Free" })).toBeTruthy();
  expect(within(free).getByText("Seats").nextElementSibling?.textContent).toBe(String(PLANS.free.seats));
  expect(within(free).getByText("Events per month").nextElementSibling?.textContent).toBe(String(PLANS.free.eventsPerMonth));
  expect(within(pro).getByText("Events per month").nextElementSibling?.textContent).toBe("Unlimited");
  expect(within(team).getByText("Audit log").nextElementSibling?.textContent).toBe("Included");
  expect(within(free).getByText("Audit log").nextElementSibling?.textContent).toBe("Not included");
  for (const tier of tiers) expect(within(tier).getByRole("link").getAttribute("href")).toBe("/signup");
});

it("switches between monthly and yearly prices", async () => {
  await renderPage();
  expect(screen.getByText("$12 a month")).toBeTruthy();
  expect(screen.getByText("$49 a month")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Yearly"));
  expect(screen.getByText("$120 a year")).toBeTruthy();
  expect(screen.getByText("$490 a year")).toBeTruthy();
  expect(screen.getByText("No charge")).toBeTruthy();
});

it("does not offer features that are not built", async () => {
  await renderPage();
  const text = document.body.textContent ?? "";
  expect(text).not.toMatch(/PDF|Excel|XLSX|image/i);
});

it("renders in Bahasa Indonesia", async () => {
  await renderPage("id");
  expect(screen.getByRole("heading", { level: 1, name: "Paket dan harga" })).toBeTruthy();
  expect(screen.getAllByText("Acara per bulan")).toHaveLength(PLAN_IDS.length);
  expect(screen.getAllByText("Tanpa batas").length).toBeGreaterThan(0);
  expect(screen.getByText(/^US\$12 per bulan$/)).toBeTruthy();
});

it("follows the plan data: a changed limit or price shows up without touching the page", () => {
  const free = PLANS.free;
  const pro = PLAN_PRICES.pro;
  const saved = { participants: free.participantsPerEvent, month: pro.month };
  try {
    free.participantsPerEvent = 7;
    pro.month = 1550;
    const tiers = buildPricing("en", en);
    expect(tiers[0].rows.find((r) => r.id === "participants")?.value).toBe("7");
    expect(tiers[1].prices?.month).toBe("$15.50 a month");
  } finally {
    free.participantsPerEvent = saved.participants;
    pro.month = saved.month;
  }
});

it("formats amounts by currency, whole amounts without decimals", () => {
  const pro = PLAN_PRICES.pro;
  const saved = { ...pro };
  try {
    pro.currency = "IDR";
    pro.month = 19900000;
    pro.year = 199000000;
    const tiers = buildPricing("id", (key, params) => translate("id", key, params));
    expect(tiers[1].prices?.month).toMatch(/^Rp\s?199\.000 per bulan$/);
    pro.currency = "EUR";
    pro.month = 1250;
    expect(buildPricing("en", en)[1].prices?.month).toBe("€12.50 a month");
  } finally {
    Object.assign(pro, saved);
  }
});

it("defines no numbers of its own: the page sources hold no figures", () => {
  for (const file of ["app/pricing/page.tsx", "components/pricing-plans.tsx", "lib/pricing.ts"]) {
    const source = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // 0, 1 and 2 serve as the cents divisor and array positions; anything else would be a price or a limit.
    const stray = (source.match(/(?<![\w.$#-])\d+(?:\.\d+)?(?![\w-])/g) ?? []).filter((n) => !["0", "1", "2", "100"].includes(n));
    expect(stray, file).toEqual([]);
  }
});
