import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The server's log email adapter appends here (`EMAIL_OUTBOX_FILE`, set in playwright.config.ts). */
export const OUTBOX_FILE = join(tmpdir(), "ow-slido-e2e-outbox.jsonl");

type Mail = { to: string; subject: string; text: string };

function readOutbox(): Mail[] {
  try {
    return readFileSync(OUTBOX_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Mail);
  } catch {
    return [];
  }
}

/** The newest mail to `to` whose text holds `/<path>?token=...`, as a link to open; polls while the server sends it. */
export async function mailLink(to: string, path: "verify" | "invite" | "reset"): Promise<string> {
  const pattern = new RegExp(`https?://\\S+/${path}\\?token=\\S+`);
  for (let attempt = 0; attempt < 50; attempt++) {
    const match = readOutbox()
      .filter((mail) => mail.to === to)
      .map((mail) => pattern.exec(mail.text)?.[0])
      .filter((link): link is string => Boolean(link))
      .pop();
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`No ${path} mail for ${to} in the outbox`);
}
