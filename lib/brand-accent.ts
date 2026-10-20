import type { MessageKey } from "@/lib/i18n/en";

/**
 * Workspace accent colour: parsing and WCAG contrast. Pure and client-safe, so the settings screen previews with
 * the same rules the server enforces.
 *
 * The owner picks one colour. Light theme uses it as is. Dark theme uses `darkAccent`, the same hue mixed toward
 * white until it reads on the dark surfaces, because no single colour can reach 4.5:1 on both a cream page and a
 * near-black one. The surface tokens below mirror DESIGN.md and app/globals.css (tests/brand-accent.test.ts compares them).
 */

export const AA_TEXT_RATIO = 4.5;

export type Theme = "light" | "dark";

export const SURFACE_TOKENS: Record<Theme, { bg: string; surface: string }> = {
  light: { bg: "#faf6ee", surface: "#fffdf8" },
  dark: { bg: "#1c1815", surface: "#26211d" },
};

/** The two `--accent-ink` values of the design tokens; text on a custom accent uses whichever reads better. */
export const INK_CHOICES = ["#fffdf8", "#1c1815"] as const;

export type ContrastPair = "textOnAccent" | "accentOnBg" | "accentOnSurface";

export type ContrastCheck = { pair: ContrastPair; theme: Theme; ratio: number; required: number; ok: boolean };

export type AccentVariant = { accent: string; ink: string };

export type AccentCheck =
  | { ok: true; hex: string; checks: ContrastCheck[]; variants: Record<Theme, AccentVariant> }
  | { ok: false; reason: "invalid_hex" }
  | { ok: false; reason: "contrast"; hex: string; checks: ContrastCheck[]; failures: ContrastCheck[] };

/** `#rgb` or `#rrggbb` in any case, to lowercase `#rrggbb`; null for anything else. */
export function parseAccent(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!match) return null;
  const digits = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
  return `#${digits.toLowerCase()}`;
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The ink with the higher contrast on `accent`. */
export function pickInk(accent: string): string {
  return INK_CHOICES.reduce((best, ink) => (contrastRatio(ink, accent) > contrastRatio(best, accent) ? ink : best));
}

function mixWithWhite(hex: string, amount: number): string {
  const [r, g, b] = channels(hex);
  return toHex([r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount]);
}

function pairChecks(theme: Theme, { accent, ink }: AccentVariant): ContrastCheck[] {
  const { bg, surface } = SURFACE_TOKENS[theme];
  const make = (pair: ContrastPair, ratio: number): ContrastCheck => ({
    pair,
    theme,
    ratio: Math.floor(ratio * 100) / 100,
    required: AA_TEXT_RATIO,
    ok: ratio >= AA_TEXT_RATIO,
  });
  return [
    make("textOnAccent", contrastRatio(ink, accent)),
    make("accentOnBg", contrastRatio(accent, bg)),
    make("accentOnSurface", contrastRatio(accent, surface)),
  ];
}

/** The colour the dark theme uses: the pick itself when it already passes there, else lightened until it does. */
export function darkAccent(hex: string): string {
  for (let step = 0; step <= 50; step++) {
    const candidate = step === 0 ? hex : mixWithWhite(hex, step * 0.02);
    if (pairChecks("dark", { accent: candidate, ink: pickInk(candidate) }).every((c) => c.ok)) return candidate;
  }
  return "#ffffff";
}

/**
 * AA (4.5:1) for the three uses of the accent: text on an accent button, and accent text, links and focus rings
 * on the page and card backgrounds. Checked in both themes; the dark theme uses `darkAccent`.
 */
export function checkAccentContrast(input: string): AccentCheck {
  const hex = parseAccent(input);
  if (!hex) return { ok: false, reason: "invalid_hex" };
  const light: AccentVariant = { accent: hex, ink: pickInk(hex) };
  const dark: AccentVariant = { accent: darkAccent(hex), ink: pickInk(darkAccent(hex)) };
  const checks = [...pairChecks("light", light), ...pairChecks("dark", dark)];
  const failures = checks.filter((c) => !c.ok).sort((a, b) => a.ratio - b.ratio);
  if (failures.length > 0) return { ok: false, reason: "contrast", hex, checks, failures };
  return { ok: true, hex, checks, variants: { light, dark } };
}

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

/** One sentence naming the worst failing pair, its theme and the ratio it reached. */
export function contrastFailureMessage(translate: Translate, hex: string, failures: ContrastCheck[]): string {
  const worst = failures[0];
  return translate("branding.contrastFailed", {
    hex,
    pair: translate(`branding.pair.${worst.pair}`),
    theme: translate(`branding.theme.${worst.theme}`),
    ratio: worst.ratio.toFixed(2),
    required: worst.required.toFixed(1),
  });
}
