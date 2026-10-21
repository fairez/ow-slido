import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/en";
import { id } from "@/lib/i18n/id";

// Keys the host dashboard, event page, content library, builders, templates, moderation and
// analysis panels render. Hosts are addressed as "Anda".
const HOST_PREFIXES = [
  "dash.",
  "eventMgr.",
  "pollMgr.",
  "moderation.",
  "moderatePage.",
  "openTextHost.",
  "notesAnalysis.",
  "analysisEditor.",
  "templates.",
  "survey.",
  "settings.",
  "retention.",
  "participantData.",
  "branding.",
  "typedConfirm.",
  // Account, members, plan, billing, audit, operator and sign-in screens (US-023).
  "members.",
  "plan.",
  "account.",
  "security.",
  "ops.",
  "auth.",
  "role.",
  "audit.",
  "logout.",
  "workspace.",
  "verify.",
  "forgot.",
  "reset.",
  "invite.",
  "suspended.",
];

// Same text in both languages: counts and tier names are not translated.
const SAME_IN_BOTH = new Set([
  "templates.itemCount.one",
  "moderation.modeLabel",
  "plan.name.free",
  "plan.name.pro",
  "plan.name.team",
  "role.admin",
  "role.editor",
  "role.moderator",
  "audit.timeUtc",
  "auth.email",
  "members.inviteEmail",
  "workspace.option",
  "ops.nav",
  "ops.status",
  "ops.ai.model",
]);

const keys = (Object.keys(en) as (keyof typeof en)[]).filter((k) =>
  HOST_PREFIXES.some((p) => k.startsWith(p)),
);

const placeholders = (s: string) => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort();

describe("Indonesian host copy", () => {
  it("covers the host keys", () => {
    expect(keys.length).toBeGreaterThan(550);
  });

  it("is not a copy of the English text", () => {
    const copied = keys.filter((k) => !SAME_IN_BOTH.has(k) && id[k] === en[k]);
    expect(copied).toEqual([]);
  });

  it("keeps every {placeholder} of the English text", () => {
    const broken = keys.filter((k) => placeholders(id[k]).join() !== placeholders(en[k]).join());
    expect(broken).toEqual([]);
  });

  it("addresses the host as Anda, never kamu", () => {
    const informal = keys.filter((k) => /\bkamu\b/i.test(id[k]));
    expect(informal).toEqual([]);
  });

  it("says host, not penyelenggara", () => {
    const other = keys.filter((k) => /penyelenggara/i.test(id[k]));
    expect(other).toEqual([]);
  });

  it("leaves the tier names alone", () => {
    expect(id["plan.name.free"]).toBe("Free");
    expect(id["plan.name.pro"]).toBe("Pro");
    expect(id["plan.name.team"]).toBe("Team");
  });
});
