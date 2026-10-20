import { config } from "dotenv";
import { Client } from "pg";

config({ path: ".env.local" });

/** Puts the host's workspace on a plan with a plan override, since e2e has no billing provider. */
export async function setPlanFor(email: string, plan: "free" | "pro" | "team") {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO subscriptions (workspace_id, plan_override, plan_override_reason)
       SELECT m.workspace_id, $2, 'e2e' FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1
       ON CONFLICT (workspace_id) DO UPDATE SET plan_override = EXCLUDED.plan_override, plan_override_reason = 'e2e'`,
      [email, plan],
    );
  } finally {
    await client.end();
  }
}

/** Marks a freshly signed-up host as verified straight in the test DB, since e2e has no inbox to read. */
export async function verifyEmail(email: string) {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query("UPDATE users SET email_verified_at = now() WHERE email = $1", [email]);
  } finally {
    await client.end();
  }
}
