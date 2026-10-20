// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { events, interactions, users, workspaces } from "@/db/schema";
import { BrandStyle, brandAttrs } from "@/components/brand-style";
import { eventAccent, eventAccentByJoinCode, interactionAccent, workspaceAccent } from "@/lib/branding";
import { checkAccentContrast } from "@/lib/brand-accent";
import { brandCss } from "@/lib/brand-style";
import { eq } from "drizzle-orm";
import { createTestDb, setPlan, truncateAll, workspaceFor } from "./helpers/db";

describe("brandCss", () => {
  it("sets only the semantic tokens, once per theme", () => {
    const css = brandCss("#1f6f5c") as string;
    const result = checkAccentContrast("#1f6f5c");
    if (!result.ok) throw new Error("expected pass");
    expect(css).toContain(`[data-brand]{--accent:#1f6f5c;--accent-ink:${result.variants.light.ink};--focus:#1f6f5c;}`);
    expect(css).toContain(`:root[data-theme="dark"] [data-brand]{--accent:${result.variants.dark.accent};`);
    expect(css).toContain('@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) [data-brand]');
    expect(result.variants.dark.accent).not.toBe("#1f6f5c");
  });

  it("is null for nothing, a bad value, or a colour that fails contrast", () => {
    expect(brandCss(null)).toBeNull();
    expect(brandCss("")).toBeNull();
    expect(brandCss("red;}body{display:none")).toBeNull();
    expect(brandCss("#f4d35e")).toBeNull();
  });
});

describe("BrandStyle", () => {
  it("renders a style element and the root attribute, or nothing", () => {
    expect(renderToStaticMarkup(<BrandStyle accent="#1f6f5c" />)).toContain("<style>");
    expect(brandAttrs("#1f6f5c")).toEqual({ "data-brand": "" });
    expect(renderToStaticMarkup(<BrandStyle accent={null} />)).toBe("");
    expect(brandAttrs(null)).toEqual({});
    expect(brandAttrs("#f4d35e")).toEqual({});
  });
});

describe("accent lookups", () => {
  const { db, pool } = createTestDb();
  beforeEach(() => truncateAll(db));
  afterAll(() => pool.end());

  async function seed(accent: string | null, plan: "free" | "team") {
    const [user] = await db.insert(users).values({ email: "o@example.com", passwordHash: "x", emailVerifiedAt: new Date() }).returning();
    const workspaceId = await workspaceFor(db, user.id);
    await db.update(workspaces).set({ brandAccent: accent }).where(eq(workspaces.id, workspaceId));
    await setPlan(db, workspaceId, plan);
    const [event] = await db
      .insert(events)
      .values({ name: "E", ownerId: user.id, workspaceId, joinCode: "123456", startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000) })
      .returning();
    const [survey] = await db.insert(interactions).values({ eventId: event.id, type: "survey", title: "S", position: 0, config: { questions: [] } }).returning();
    return { workspaceId, event, survey };
  }

  it("returns the colour for every audience entry point while the plan has branding", async () => {
    const { workspaceId, event, survey } = await seed("#1f6f5c", "team");
    expect(await workspaceAccent(workspaceId, db)).toBe("#1f6f5c");
    expect(await eventAccent(event.id, db)).toBe("#1f6f5c");
    expect(await eventAccentByJoinCode("123456", db)).toBe("#1f6f5c");
    expect(await interactionAccent(survey.id, db)).toBe("#1f6f5c");
  });

  it("returns null after a downgrade, without clearing the stored colour", async () => {
    const { workspaceId, event } = await seed("#1f6f5c", "free");
    expect(await workspaceAccent(workspaceId, db)).toBeNull();
    expect(await eventAccent(event.id, db)).toBeNull();
    const [row] = await db.select({ a: workspaces.brandAccent }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(row.a).toBe("#1f6f5c");
  });

  it("returns null with no colour, an unknown code or a malformed code", async () => {
    const { workspaceId } = await seed(null, "team");
    expect(await workspaceAccent(workspaceId, db)).toBeNull();
    expect(await eventAccentByJoinCode("999999", db)).toBeNull();
    expect(await eventAccentByJoinCode("abc'; --", db)).toBeNull();
  });
});
