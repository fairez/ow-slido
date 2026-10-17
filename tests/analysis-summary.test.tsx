// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AnalysisSummary } from "@/components/analysis-summary";
import { parseSummary } from "@/lib/analysis-summary";

afterEach(cleanup);

it("parses headings, bullets and paragraphs", () => {
  expect(parseSummary("## Ringkasan\nRapat panjang.\nDan melelahkan.\n\n## Poin utama\n- Jeda kurang\n* Kopi kurang\n• Wifi lambat")).toEqual([
    { type: "heading", text: "Ringkasan" },
    { type: "paragraph", text: "Rapat panjang. Dan melelahkan." },
    { type: "heading", text: "Poin utama" },
    { type: "list", items: ["Jeda kurang", "Kopi kurang", "Wifi lambat"] },
  ]);
});

it("strips bold markers and ignores empty headings", () => {
  expect(parseSummary("## **Overview**\n- **Key** point\n##")).toEqual([
    { type: "heading", text: "Overview" },
    { type: "list", items: ["Key point"] },
  ]);
});

it("treats an old single-paragraph summary as one paragraph", () => {
  expect(parseSummary("Everyone liked the short breaks.")).toEqual([{ type: "paragraph", text: "Everyone liked the short breaks." }]);
});

it("renders headings and a real list", () => {
  render(<AnalysisSummary text={"## Poin utama\n- Satu\n- Dua"} className="analysis-summary" />);
  expect(screen.getByRole("heading", { name: "Poin utama" })).toBeTruthy();
  expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Satu", "Dua"]);
});
