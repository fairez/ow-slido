import { brandCss } from "@/lib/brand-style";

/**
 * Puts the workspace accent on a screen. Render it next to a root that carries `data-brand` (see `brandAttrs`);
 * with no accent, or one that fails contrast, it renders nothing and the default accent stays.
 */
export function BrandStyle({ accent }: { accent: string | null }) {
  const css = brandCss(accent);
  return css ? <style dangerouslySetInnerHTML={{ __html: css }} /> : null;
}

/** Spread on the screen root: `<main {...brandAttrs(accent)}>`. */
export function brandAttrs(accent: string | null): { "data-brand"?: "" } {
  return brandCss(accent) ? { "data-brand": "" } : {};
}
