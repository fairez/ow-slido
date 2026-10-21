import { eq } from "drizzle-orm";
import type { createDb } from "@/db/client";
import { users } from "@/db/schema";
import { getEmailSender } from "@/lib/email";
import { t } from "@/lib/i18n";
import { emailLocale } from "@/lib/i18n/email-locale";
import { requestLocale } from "@/lib/i18n/server";
import { consumeToken, issueToken } from "./tokens";

type Db = ReturnType<typeof createDb>["db"];

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

/** Issues a verification token and emails the link to the user's own address. */
export async function sendVerificationEmail(db: Db, request: Request, user: { id: string; email: string }) {
  const token = await issueToken(db, { userId: user.id, purpose: "verify_email", ttlMs: VERIFY_TTL_MS });
  const link = `${new URL(request.url).origin}/verify?token=${encodeURIComponent(token)}`;
  const locale = await emailLocale(db, user.email, requestLocale(request));
  await getEmailSender().send({
    to: user.email,
    subject: t(locale, "email.verify.subject"),
    text: t(locale, "email.verify.body", { link }),
  });
}

/** Marks the token's owner as verified. False when the token is unknown, expired or already used. */
export async function verifyEmailToken(db: Db, token: string): Promise<boolean> {
  const consumed = await consumeToken(db, token, "verify_email");
  if (!consumed?.userId) return false;
  await db
    .update(users)
    .set({ emailVerifiedAt: new Date() })
    .where(eq(users.id, consumed.userId));
  return true;
}
