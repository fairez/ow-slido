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

async function withClient<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** The id of the workspace the account signed up with. */
export async function workspaceIdOf(email: string): Promise<string> {
  return withClient(async (client) => {
    const { rows } = await client.query(
      "SELECT m.workspace_id AS id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1 ORDER BY m.created_at LIMIT 1",
      [email],
    );
    return rows[0].id as string;
  });
}

/** Ends a paid subscription the way the daily sweep eventually does: canceled, period over. Free again. */
export async function endSubscription(email: string) {
  await withClient((client) =>
    client.query(
      `UPDATE subscriptions SET status = 'canceled', current_period_end = now() - interval '1 day'
       WHERE workspace_id IN (SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1)`,
      [email],
    ),
  );
}

/** Removes an account left by an earlier run, for the one address the server treats as an operator. */
export async function forgetUser(email: string) {
  await withClient((client) => client.query("DELETE FROM users WHERE email = $1", [email]));
}
