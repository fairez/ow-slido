"use client";

import { useId, useState, type CSSProperties, type FormEvent } from "react";
import { PlanError } from "@/components/plan-error";
import { PlanHint } from "@/components/plan-hint";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/field";
import { apiError, type ApiError } from "@/lib/api-error";
import {
  DEFAULT_ACCENT,
  SURFACE_TOKENS,
  checkAccentContrast,
  contrastFailureMessage,
  darkAccent,
  parseAccent,
  pickInk,
  type AccentVariant,
  type Theme,
} from "@/lib/brand-accent";
import { NETWORK_ERROR } from "@/lib/copy";
import { useT } from "@/lib/i18n/client";
import type { Lock } from "@/lib/plan-hints";

const THEMES: Theme[] = ["light", "dark"];

function variantsFor(hex: string): Record<Theme, AccentVariant> {
  const dark = darkAccent(hex);
  return { light: { accent: hex, ink: pickInk(hex) }, dark: { accent: dark, ink: pickInk(dark) } };
}

/** A picture of the join screen in one theme, painted with the same tokens the participant screens use. */
function PreviewPanel({ theme, variant, label }: { theme: Theme; variant: AccentVariant; label: string }) {
  const t = useT();
  const surface = SURFACE_TOKENS[theme];
  const style = {
    "--preview-bg": surface.bg,
    "--preview-surface": surface.surface,
    "--preview-ink": surface.ink,
    "--preview-accent": variant.accent,
    "--preview-accent-ink": variant.ink,
  } as CSSProperties;
  return (
    <div className="brand-preview" style={style} data-theme-preview={theme}>
      <p className="brand-preview-label">{label}</p>
      <div className="brand-preview-card" aria-hidden="true">
        <p className="brand-preview-title">{t("branding.preview.title")}</p>
        <span className="brand-preview-button">{t("branding.preview.button")}</span>
        <span className="brand-preview-link">{t("branding.preview.link")}</span>
        <span className="brand-preview-focus">{t("branding.preview.focus")}</span>
      </div>
    </div>
  );
}

export function BrandingSettings({ initial, lock }: { initial: string | null; lock?: Lock }) {
  const t = useT();
  const inputId = useId();
  const hintId = useId();
  const [saved, setSaved] = useState<string | null>(initial);
  const [text, setText] = useState(initial ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const typed = text.trim();
  const hex = parseAccent(typed);
  const check = hex ? checkAccentContrast(hex) : null;
  const passes = check?.ok === true;
  const variants = hex ? variantsFor(hex) : null;
  const checks = check && (check.ok || check.reason === "contrast") ? check.checks : null;
  const unchanged = hex !== null && hex === saved;

  let summary: string;
  if (!typed) summary = t("branding.result.empty");
  else if (!hex || !check) summary = t("api.brandingInvalidColour");
  else if (check.ok) summary = t("branding.result.pass");
  else summary = contrastFailureMessage(t, hex, check.reason === "contrast" ? check.failures : []);

  async function send(accent: string | null) {
    if (pending) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/workspaces/active/branding", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accent }),
      });
      if (!response.ok) {
        setError(await apiError(response));
        return;
      }
      setSaved(accent);
      setText(accent ?? "");
      setNotice(accent ? t("branding.saved") : t("branding.removed"));
    } catch {
      setError({ message: NETWORK_ERROR, lock: null });
    } finally {
      setPending(false);
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (!hex || !passes || unchanged) return;
    void send(hex);
  }

  const savedRow = saved ? (
    <p className="row-meta">
      <span className="brand-swatch" style={{ "--preview-accent": saved } as CSSProperties} aria-hidden="true" />
      {lock ? t("branding.savedLocked", { hex: saved }) : t("branding.current", { hex: saved })}
    </p>
  ) : (
    <p className="row-meta">{t("branding.none")}</p>
  );

  if (lock) {
    return (
      <section aria-labelledby="branding-heading" className="member-policy">
        <h2 id="branding-heading">{t("branding.title")}</h2>
        <p className="row-meta">{t("branding.lead")}</p>
        {savedRow}
        <PlanHint lock={lock}>{t("branding.unlock")}</PlanHint>
        {saved && (
          <Button onClick={() => void send(null)} busy={pending}>
            {t("branding.remove")}
          </Button>
        )}
        {notice && (
          <p role="status" className="retention-saved">
            {notice}
          </p>
        )}
        {error && <InlineError>{error.message}</InlineError>}
      </section>
    );
  }

  return (
    <section aria-labelledby="branding-heading" className="member-policy">
      <h2 id="branding-heading">{t("branding.title")}</h2>
      <p className="row-meta">{t("branding.lead")}</p>
      {savedRow}
      <form onSubmit={save} className="retention-form" noValidate>
        <div className="brand-field">
          <label htmlFor={inputId}>{t("branding.label")}</label>
          <p className="ui-hint" id={hintId}>
            {t("branding.hint")}
          </p>
          <div className="brand-inputs">
            <input
              type="color"
              aria-label={t("branding.picker")}
              value={hex ?? saved ?? DEFAULT_ACCENT}
              onChange={(e) => {
                setText(e.target.value);
                setNotice(null);
              }}
            />
            <input
              id={inputId}
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              maxLength={7}
              placeholder={DEFAULT_ACCENT}
              value={text}
              aria-describedby={hintId}
              aria-invalid={typed && !hex ? true : undefined}
              onChange={(e) => {
                setText(e.target.value);
                setNotice(null);
              }}
            />
          </div>
        </div>

        {variants && (
          <div className="brand-previews">
            {THEMES.map((theme) => (
              <PreviewPanel key={theme} theme={theme} variant={variants[theme]} label={t(`branding.preview.${theme}`)} />
            ))}
          </div>
        )}

        <p role="status" className="brand-summary" data-ok={passes ? "true" : undefined}>
          {summary}
        </p>
        {checks && (
          <table className="brand-checks">
            <caption>{t("branding.checks.caption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("branding.checks.pair")}</th>
                {THEMES.map((theme) => (
                  <th key={theme} scope="col">
                    {t(`branding.theme.${theme}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(["textOnAccent", "accentOnBg", "accentOnSurface"] as const).map((pair) => (
                <tr key={pair}>
                  <th scope="row">{t(`branding.pair.${pair}`)}</th>
                  {THEMES.map((theme) => {
                    const row = checks.find((c) => c.pair === pair && c.theme === theme);
                    return (
                      <td key={theme}>
                        {row ? `${row.ratio.toFixed(2)}:1 ${row.ok ? t("branding.checks.pass") : t("branding.checks.fail")}` : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="brand-actions">
          <Button type="submit" variant="primary" busy={pending} aria-disabled={!passes || unchanged || undefined}>
            {pending ? t("branding.saving") : t("branding.save")}
          </Button>
          {saved && (
            <Button onClick={() => void send(null)} busy={pending}>
              {t("branding.remove")}
            </Button>
          )}
        </div>
        {notice && (
          <p role="status" className="retention-saved">
            {notice}
          </p>
        )}
        {error && <PlanError error={error} unlock={t("branding.unlock")} />}
      </form>
    </section>
  );
}
