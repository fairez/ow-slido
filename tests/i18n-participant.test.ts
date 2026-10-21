import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/en";
import { id } from "@/lib/i18n/id";

// Keys the join page, the participant view and every participant interaction screen render.
const PARTICIPANT_PREFIXES = [
  "error.",
  "join.",
  "home.",
  "notFound.",
  "theme.",
  "shell.",
  "tabs.",
  "common.",
  "live.",
  "liveCount.",
  "openText.",
  "rating.",
  "ratingChart.",
  "ranking.",
  "quiz.",
  "leaderboard.",
  "qa.",
  "notes.",
  "wordcloud.",
  "surveyForm.",
];

// Names and brand strings that read the same in both languages.
const SAME_IN_BOTH = new Set(["shell.brand", "language.name.en", "language.name.id"]);

const keys = (Object.keys(en) as (keyof typeof en)[]).filter((k) =>
  PARTICIPANT_PREFIXES.some((p) => k.startsWith(p)),
);

const placeholders = (s: string) => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort();

describe("Indonesian participant copy", () => {
  it("covers the participant keys", () => {
    expect(keys.length).toBeGreaterThan(150);
  });

  it("is not a copy of the English text", () => {
    const copied = keys.filter((k) => !SAME_IN_BOTH.has(k) && id[k] === en[k]);
    expect(copied).toEqual([]);
  });

  it("keeps every {placeholder} of the English text", () => {
    const broken = keys.filter((k) => placeholders(id[k]).join() !== placeholders(en[k]).join());
    expect(broken).toEqual([]);
  });

  it("addresses the participant as kamu, never Anda", () => {
    const formal = keys.filter((k) => /\b(Anda|anda)\b/.test(id[k]));
    expect(formal).toEqual([]);
  });

  it("says host, not penyelenggara", () => {
    const other = keys.filter((k) => /penyelenggara/i.test(id[k]));
    expect(other).toEqual([]);
  });
});
