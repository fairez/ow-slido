import { config } from "dotenv";
import { Client } from "pg";

config({ path: ".env.local" });

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
