// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { events, users, workspaces } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { sendResetEmail } from "@/lib/auth/password-reset";
import { consumeToken } from "@/lib/auth/tokens";
import { sendVerificationEmail, verifyEmailToken } from "@/lib/auth/verification";
import { clearOutbox, getOutbox, resetEmailSender } from "@/lib/email";
import { LOCALES, t, type Locale } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import { id } from "@/lib/i18n/id";
import { sendInvitationEmail } from "@/lib/invitations";
import { runRetention } from "@/lib/retention";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

// Same text in both languages: nothing yet; add a key here only when it must not be translated.
const SAME_IN_BOTH = new Set<string>([]);

const keys = (Object.keys(en) as (keyof typeof en)[]).filter((k) => /^(api|email)\./.test(k));
const placeholders = (s: string) => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort();

describe("Indonesian API errors and emails", () => {
  it("covers the api and email keys", () => {
    expect(keys.length).toBeGreaterThan(200);
    expect(keys.filter((k) => k.startsWith("email.")).length).toBe(8);
  });

  it("is not a copy of the English text", () => {
    expect(keys.filter((k) => !SAME_IN_BOTH.has(k) && id[k] === en[k])).toEqual([]);
  });

  it("keeps every {placeholder} of the English text", () => {
    expect(keys.filter((k) => placeholders(id[k]).join() !== placeholders(en[k]).join())).toEqual([]);
  });

  it("keeps the link, the minutes and the days in the email bodies", () => {
    for (const key of ["email.verify.body", "email.reset.body", "email.invite.body"] as const) {
      expect(id[key]).toContain("{link}");
    }
    expect(id["email.reset.body"]).toContain("{minutes}");
    expect(id["email.invite.body"]).toContain("{days}");
  });
});

describe("email language", () => {
  beforeEach(async () => {
    vi.stubEnv("EMAIL_PROVIDER", "log");
    resetEmailSender();
    clearOutbox();
    await truncateAll(db);
  });
  afterAll(() => pool.end());

  const request = (headers: Record<string, string> = {}) =>
    new Request("http://localhost/api/x", { method: "POST", headers });

  async function makeUser(email: string, locale: Locale | null) {
    const [user] = await db
      .insert(users)
      .values({ email, passwordHash: await hashPassword("a long password"), emailVerifiedAt: new Date(), locale })
      .returning();
    return user;
  }
  const linkIn = (text: string) => /https?:\/\/\S+/.exec(text)?.[0] ?? "";
  const tokenIn = (text: string) => decodeURIComponent(/token=([^\s]+)/.exec(text)?.[1] ?? "");

  for (const locale of LOCALES) {
    it(`sends the verification email in ${locale} with the token intact`, async () => {
      const user = await makeUser("a@example.com", locale);
      // The request asks for the other language: the saved choice wins.
      const other = locale === "en" ? "id" : "en";
      await sendVerificationEmail(db, request({ "accept-language": other }), user);
      const [mail] = getOutbox();
      expect(mail.to).toBe("a@example.com");
      expect(mail.subject).toBe(t(locale, "email.verify.subject"));
      expect(mail.text.startsWith(t(locale, "email.verify.body", { link: linkIn(mail.text) }))).toBe(true);
      expect(linkIn(mail.text)).toMatch(/^http:\/\/localhost\/verify\?token=/);
      await db.update(users).set({ emailVerifiedAt: null }).where(eq(users.id, user.id));
      expect(await verifyEmailToken(db, tokenIn(mail.text))).toBe(true);
    });

    it(`sends the reset email in ${locale} with the token intact`, async () => {
      const user = await makeUser("b@example.com", locale);
      await sendResetEmail(db, request({ "accept-language": locale === "en" ? "id" : "en" }), user.email);
      const [mail] = getOutbox();
      expect(mail.subject).toBe(t(locale, "email.reset.subject"));
      expect(mail.text).toBe(t(locale, "email.reset.body", { link: linkIn(mail.text), minutes: 60 }));
      expect(linkIn(mail.text)).toMatch(/^http:\/\/localhost\/reset\?token=/);
      expect(await consumeToken(db, tokenIn(mail.text), "reset_password")).toEqual({ userId: user.id });
    });

    it(`sends the invitation in ${locale} with the link and role intact`, async () => {
      const owner = await makeUser("owner@example.com", null);
      const workspace = await createPersonalWorkspace(db, owner);
      await makeUser("invitee@example.com", locale);
      const link = "http://localhost/invite?token=abc%2Bdef";
      const sent = await sendInvitationEmail(
        db,
        { workspaceId: workspace.id, email: "Invitee@Example.com", role: "editor", link },
        locale === "en" ? "id" : "en",
      );
      expect(sent).toBe(true);
      const [mail] = getOutbox();
      expect(mail.subject).toBe(t(locale, "email.invite.subject", { workspace: workspace.name }));
      expect(mail.text).toBe(
        t(locale, "email.invite.body", { workspace: workspace.name, role: t(locale, "role.editor"), link, days: 7 }),
      );
      expect(mail.text).toContain(link);
    });
  }

  it("uses the request language when the recipient has no saved one", async () => {
    const user = await makeUser("c@example.com", null);
    await sendResetEmail(db, request({ cookie: "lang=id" }), user.email);
    expect(getOutbox().at(-1)?.subject).toBe(t("id", "email.reset.subject"));
    clearOutbox();
    await sendResetEmail(db, request({ "accept-language": "en-US" }), user.email);
    expect(getOutbox().at(-1)?.subject).toBe(t("en", "email.reset.subject"));
  });

  it("invites an address without an account in the request language", async () => {
    const owner = await makeUser("owner@example.com", "en");
    const workspace = await createPersonalWorkspace(db, owner);
    const link = "http://localhost/invite?token=xyz";
    await sendInvitationEmail(db, { workspaceId: workspace.id, email: "new@example.com", role: "viewer", link }, "id");
    expect(getOutbox()[0].subject).toBe(t("id", "email.invite.subject", { workspace: workspace.name }));
    expect(getOutbox()[0].text).toContain(link);
  });

  for (const locale of LOCALES) {
    it(`sends the retention notice in ${locale}, the owner's saved language`, async () => {
      const owner = await makeUser("owner@example.com", locale);
      const workspace = await createPersonalWorkspace(db, owner);
      await db.update(workspaces).set({ retentionDays: 30 }).where(eq(workspaces.id, workspace.id));
      const endsAt = new Date("2026-01-01T12:00:00Z");
      await db.insert(events).values({
        ownerId: owner.id,
        workspaceId: workspace.id,
        name: "Town hall",
        startsAt: new Date(endsAt.getTime() - 3600_000),
        endsAt,
        joinCode: "4821",
      });
      const now = new Date(endsAt.getTime() + 23 * 24 * 60 * 60 * 1000);
      expect(await runRetention(db, now)).toEqual({ warned: 1, deleted: 0 });
      const params = { event: "Town hall", workspace: workspace.name, date: "2026-01-31" };
      const [mail] = getOutbox();
      expect(mail.subject).toBe(t(locale, "email.retention.subject", params));
      expect(mail.text).toBe(t(locale, "email.retention.body", params));
    });
  }

  it("sends the retention notice in English to an owner who never chose a language", async () => {
    const owner = await makeUser("owner@example.com", null);
    const workspace = await createPersonalWorkspace(db, owner);
    await db.update(workspaces).set({ retentionDays: 30 }).where(eq(workspaces.id, workspace.id));
    const endsAt = new Date("2026-01-01T12:00:00Z");
    await db.insert(events).values({
      ownerId: owner.id,
      workspaceId: workspace.id,
      name: "Town hall",
      startsAt: new Date(endsAt.getTime() - 3600_000),
      endsAt,
      joinCode: "4822",
    });
    await runRetention(db, new Date(endsAt.getTime() + 23 * 24 * 60 * 60 * 1000));
    expect(getOutbox()[0].subject).toBe("Town hall will be deleted on 2026-01-31");
  });
});
