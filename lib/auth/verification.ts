import { eq } from "drizzle-orm";
import type { createDb } from "@/db/client";
import { users } from "@/db/schema";
import { getEmailSender } from "@/lib/email";
import { serverT } from "@/lib/i18n/server";
import { consumeToken, issueToken } from "./tokens";

type Db = ReturnType<typeof createDb>["db"];

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

/** Issues a verification token and emails the link to the user's own address. */
export async function sendVerificationEmail(db: Db, request: Request, user: { id: string; email: string }) {
  const token = await issueToken(db, { userId: user.id, purpose: "verify_email", ttlMs: VERIFY_TTL_MS });
  const link = `${new URL(request.url).origin}/verify?token=${encodeURIComponent(token)}`;
  await getEmailSender().send({
    to: user.email,
    subject: serverT(request, "email.verify.subject"),
    text: serverT(request, "email.verify.body", { link }),
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
