import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { en } from "@/lib/i18n/en";
import { id } from "@/lib/i18n/id";
import { t } from "@/lib/i18n";
import { resolveLocale } from "@/lib/i18n/locale";
import { I18nProvider, useT } from "@/lib/i18n/client";
import * as copy from "@/lib/copy";

describe("message files", () => {
  it("id has exactly the keys of en", () => {
    expect(Object.keys(id).sort()).toEqual(Object.keys(en).sort());
  });
});

describe("t()", () => {
  it("returns the message for the locale", () => {
    expect(t("en", "error.server")).toBe(en["error.server"]);
    expect(t("id", "error.server")).toBe(id["error.server"]);
  });

  it("interpolates {name} params and leaves unknown ones", () => {
    const original = en["error.server"];
    (en as Record<string, string>)["error.server"] = "Hi {name}, {n} left, {other}";
    try {
      expect(t("en", "error.server", { name: "Ada", n: 3 })).toBe("Hi Ada, 3 left, {other}");
    } finally {
      (en as Record<string, string>)["error.server"] = original;
    }
  });
});

describe("resolveLocale", () => {
  it("prefers the cookie", () => {
    expect(resolveLocale("id", "en-US,en;q=0.9")).toBe("id");
  });
  it("falls back to Accept-Language by q-value", () => {
    expect(resolveLocale(undefined, "fr;q=0.9,id-ID;q=0.8,en;q=0.5")).toBe("id");
    expect(resolveLocale(undefined, "id;q=0.2,en;q=0.9")).toBe("en");
  });
  it("ignores an unsupported cookie and defaults to en", () => {
    expect(resolveLocale("xx", null)).toBe("en");
    expect(resolveLocale(null, "fr,de")).toBe("en");
    expect(resolveLocale()).toBe("en");
  });
});

describe("useT", () => {
  function Probe() {
    const tr = useT();
    return <p>{tr("error.network")}</p>;
  }
  it("reads the provider locale", () => {
    expect(renderToString(<I18nProvider locale="en"><Probe /></I18nProvider>)).toContain("Could not reach");
  });
});

describe("lib/copy", () => {
  it("re-exports through t('en')", () => {
    expect(copy.SERVER_ERROR).toBe(t("en", "error.server"));
    expect(copy.JOIN_STUCK).toBe(t("en", "join.stuck"));
  });
});
