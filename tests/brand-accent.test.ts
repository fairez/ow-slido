import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INK_CHOICES,
  SURFACE_TOKENS,
  checkAccentContrast,
  contrastFailureMessage,
  contrastRatio,
  darkAccent,
  parseAccent,
  pickInk,
} from "@/lib/brand-accent";
import { t } from "@/lib/i18n";

describe("parseAccent", () => {
  it("normalises 3 and 6 digit hex to lowercase #rrggbb", () => {
    expect(parseAccent("#1F6F5C")).toBe("#1f6f5c");
    expect(parseAccent(" #abc ")).toBe("#aabbcc");
  });

  it("rejects anything else", () => {
    for (const bad of ["1f6f5c", "#12345", "#gggggg", "red", "", "#1f6f5c80", null, 5]) expect(parseAccent(bad)).toBeNull();
  });
});

describe("contrastRatio", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
  });
});

describe("checkAccentContrast", () => {
  it("accepts a deep green and gives both themes a variant that passes", () => {
    const result = checkAccentContrast("#1F6F5C");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hex).toBe("#1f6f5c");
    expect(result.variants.light.accent).toBe("#1f6f5c");
    for (const check of result.checks) expect(check.ratio).toBeGreaterThanOrEqual(4.5);
    expect(result.checks).toHaveLength(6);
    // the dark theme lightens the pick, keeping its hue family
    expect(result.variants.dark.accent).not.toBe("#1f6f5c");
    expect(contrastRatio(result.variants.dark.accent, SURFACE_TOKENS.dark.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("accepts the default accent", () => {
    expect(checkAccentContrast("#b5472b").ok).toBe(true);
  });

  it("rejects a pale colour on the light theme and names the failing pair", () => {
    const result = checkAccentContrast("#f4d35e");
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "contrast") throw new Error("expected a contrast failure");
    expect(result.failures.every((f) => f.theme === "light")).toBe(true);
    expect(result.failures.map((f) => f.pair)).toEqual(expect.arrayContaining(["accentOnBg", "accentOnSurface"]));
    expect(result.failures[0].ratio).toBeLessThan(4.5);
    // worst first
    expect(result.failures[0].ratio).toBeLessThanOrEqual(result.failures[result.failures.length - 1].ratio);
  });

  it("rejects a mid-tone colour where neither ink reaches 4.5:1", () => {
    const result = checkAccentContrast("#808080");
    expect(result.ok).toBe(false);
  });

  it("rejects pure white, and reports bad input as invalid_hex", () => {
    expect(checkAccentContrast("#ffffff").ok).toBe(false);
    expect(checkAccentContrast("blue")).toEqual({ ok: false, reason: "invalid_hex" });
  });

  it("accepts black (light theme) and the dark variant stays readable", () => {
    const result = checkAccentContrast("#000");
    expect(result.ok).toBe(true);
    expect(contrastRatio(darkAccent("#000000"), SURFACE_TOKENS.dark.bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("pickInk", () => {
  it("uses the light ink on dark accents and the dark ink on light ones", () => {
    expect(pickInk("#1f6f5c")).toBe(INK_CHOICES[0]);
    expect(pickInk("#e07a5a")).toBe(INK_CHOICES[1]);
  });
});

describe("contrastFailureMessage", () => {
  it("names the pair, theme, ratio and requirement in both languages", () => {
    const result = checkAccentContrast("#f4d35e");
    if (result.ok || result.reason !== "contrast") throw new Error("expected a contrast failure");
    const en = contrastFailureMessage((k, p) => t("en", k, p), result.hex, result.failures);
    expect(en).toContain("#f4d35e");
    expect(en).toContain("light");
    expect(en).toContain(`${result.failures[0].ratio.toFixed(2)}:1`);
    expect(en).toContain("needs 4.5:1");
    const id = contrastFailureMessage((k, p) => t("id", k, p), result.hex, result.failures);
    expect(id).toContain("terang");
    expect(id).not.toBe(en);
  });
});

describe("surface tokens", () => {
  it("match app/globals.css and DESIGN.md", () => {
    const css = readFileSync("app/globals.css", "utf8");
    const design = readFileSync("DESIGN.md", "utf8");
    for (const [name, light, dark] of [
      ["bg", SURFACE_TOKENS.light.bg, SURFACE_TOKENS.dark.bg],
      ["surface", SURFACE_TOKENS.light.surface, SURFACE_TOKENS.dark.surface],
    ]) {
      expect(css).toContain(`--${name}: ${light};`);
      expect(css).toContain(`--${name}: ${dark};`);
      expect(design.toLowerCase()).toContain(`| \`--${name}\` | ${light} | ${dark} |`);
    }
    expect(css).toContain(`--accent-ink: ${INK_CHOICES[0]};`);
    expect(css).toContain(`--accent-ink: ${INK_CHOICES[1]};`);
  });
});
