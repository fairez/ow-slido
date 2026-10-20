import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { createDb } from "@/db/client";
import { authTokens } from "@/db/schema";

type Db = ReturnType<typeof createDb>["db"];

export type TokenPurpose = "verify_email" | "reset_password" | "invite";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Creates a token and returns the raw value to put in a link; only its hash is stored. */
export async function issueToken(
  db: Db,
  input: { userId: string | null; purpose: TokenPurpose; ttlMs: number },
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(authTokens).values({
    userId: input.userId,
    purpose: input.purpose,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + input.ttlMs),
  });
  return token;
}

/**
 * Marks the token used and returns its owner, or null if it is unknown, expired, already
 * used or issued for another purpose. The single UPDATE makes concurrent use race-safe.
 */
export async function consumeToken(
  db: Db,
  token: string,
  purpose: TokenPurpose,
): Promise<{ userId: string | null } | null> {
  const [row] = await db
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(authTokens.tokenHash, hashToken(token)),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, new Date()),
      ),
    )
    .returning({ userId: authTokens.userId });
  return row ?? null;
}
