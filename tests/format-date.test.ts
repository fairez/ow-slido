import { describe, expect, it } from "vitest";
import { formatDay } from "@/lib/format-date";

describe("formatDay", () => {
  it("writes the UTC day in Indonesian", () => {
    expect(formatDay("2026-10-20T23:30:00Z", "id")).toBe("20 Okt 2026");
  });

  it("writes the UTC day in English", () => {
    expect(formatDay(new Date("2026-10-20T23:30:00Z"), "en")).toBe("Oct 20, 2026");
  });
});

describe("Rupiah amounts", () => {
  it("use the rupiah sign without decimals in Indonesian", () => {
    const text = new Intl.NumberFormat("id", { style: "currency", currency: "IDR", minimumFractionDigits: 0 }).format(150000);
    expect(text.replace(/\s/g, " ")).toBe("Rp 150.000");
  });
});
