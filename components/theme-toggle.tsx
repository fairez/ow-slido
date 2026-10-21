"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { applyTheme, readStoredTheme, systemTheme, type Theme } from "@/lib/theme";

export function ThemeToggle() {
  const t = useT();
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- DOM and storage are only readable after mount
    setTheme(current === "light" || current === "dark" ? current : (readStoredTheme() ?? systemTheme()));
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(next, true);
    setTheme(next);
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-pressed={theme === "dark"}
    >
      {t("theme.label")}
    </button>
  );
}
