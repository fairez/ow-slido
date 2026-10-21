import { eq } from "drizzle-orm";
import type { createDb } from "@/db/client";
import { users } from "@/db/schema";
import { getEmailSender } from "@/lib/email";
import { t } from "@/lib/i18n";
import { emailLocale } from "@/lib/i18n/email-locale";
import { requestLocale } from "@/lib/i18n/server";
import { hashPassword } from "./password";
import { consumeToken, issueToken } from "./tokens";

type Db = ReturnType<typeof createDb>["db"];

export const RESET_TTL_MINUTES = 60;

/** Emails a reset link to an active account; does nothing for unknown or deactivated addresses. */
export async function sendResetEmail(db: Db, request: Request, email: string) {
  const [user] = await db
    .select({ id: users.id, email: users.email, active: users.active })
    .from(users)
    .where(eq(users.email, email));
  if (!user?.active) return;
  const token = await issueToken(db, { userId: user.id, purpose: "reset_password", ttlMs: RESET_TTL_MINUTES * 60_000 });
  const link = `${new URL(request.url).origin}/reset?token=${encodeURIComponent(token)}`;
  const locale = await emailLocale(db, user.email, requestLocale(request));
  await getEmailSender().send({
    to: user.email,
    subject: t(locale, "email.reset.subject"),
    text: t(locale, "email.reset.body", { link, minutes: RESET_TTL_MINUTES }),
  });
}

/** Ends every session issued before now; the caller sets a fresh cookie for the current device. */
export async function setSessionsValidAfter(db: Db, userId: string) {
  await db.update(users).set({ sessionsValidAfter: new Date() }).where(eq(users.id, userId));
}

/** Stores a new password, clears the forced-change flag and ends every session issued before now. */
export async function setPassword(db: Db, userId: string, password: string) {
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(password), mustChangePassword: false, sessionsValidAfter: new Date() })
    .where(eq(users.id, userId));
}

/** Spends the reset token and sets the password; returns the user id, or null if the link is not valid. */
export async function resetPasswordWithToken(db: Db, token: string, password: string): Promise<string | null> {
  const consumed = await consumeToken(db, token, "reset_password");
  if (!consumed?.userId) return null;
  const [user] = await db.select({ active: users.active }).from(users).where(eq(users.id, consumed.userId));
  if (!user?.active) return null;
  await setPassword(db, consumed.userId, password);
  return consumed.userId;
}
