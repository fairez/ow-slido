import { checkAccentContrast } from "@/lib/brand-accent";

/** Attribute on the screen root that opts a subtree into the workspace accent; see `brandCss`. */
export const BRAND_ATTRIBUTE = "data-brand";

/**
 * The CSS that applies a workspace accent to every element under `[data-brand]`, in both themes. It only sets the
 * semantic tokens (`--accent`, `--accent-ink`, `--focus`), so every rule in globals.css that reads them follows.
 * Light uses the pick as is; dark uses the lightened variant (see lib/brand-accent.ts). The theme selectors repeat
 * the ones in globals.css: the system preference unless `data-theme` says otherwise.
 *
 * Returns null for anything that is not a colour passing AA, so a bad stored value falls back to the default accent.
 * The output only contains hex values that went through `parseAccent`, never the raw input.
 */
export function brandCss(accent: string | null | undefined): string | null {
  if (!accent) return null;
  const check = checkAccentContrast(accent);
  if (!check.ok) return null;
  const { light, dark } = check.variants;
  const tokens = (v: { accent: string; ink: string }) => `--accent:${v.accent};--accent-ink:${v.ink};--focus:${v.accent};`;
  return [
    `[${BRAND_ATTRIBUTE}]{${tokens(light)}}`,
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) [${BRAND_ATTRIBUTE}]{${tokens(dark)}}}`,
    `:root[data-theme="dark"] [${BRAND_ATTRIBUTE}]{${tokens(dark)}}`,
  ].join("\n");
}
