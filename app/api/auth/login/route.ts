import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { readCredentials } from "@/lib/auth/credentials";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { sessionSetCookie } from "@/lib/auth/session";
import { getDb } from "@/lib/db";

const invalid = () => Response.json({ error: "Invalid email or password" }, { status: 401 });

// Compared against when the email is unknown so response time doesn't reveal which emails exist.
const dummyHash = hashPassword("dummy-password-for-timing");

export async function POST(request: Request) {
  const creds = await readCredentials(request);
  if (!creds) return invalid();

  const [user] = await getDb().select().from(users).where(eq(users.email, creds.email));
  const passwordOk = await verifyPassword(creds.password, user?.passwordHash ?? (await dummyHash));
  if (!user || !user.active || !passwordOk) return invalid();

  return Response.json(
    { user: { id: user.id, email: user.email } },
    { headers: { "set-cookie": sessionSetCookie(user.id) } },
  );
}
