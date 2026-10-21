import { appendFileSync } from "node:fs";
import type { EmailMessage, EmailSender } from "./types";

const outbox: EmailMessage[] = [];

/** Messages captured by the log adapter, oldest first. Lives in memory only. */
export function getOutbox(): readonly EmailMessage[] {
  return outbox;
}

export function clearOutbox() {
  outbox.length = 0;
}

/**
 * Keeps messages in memory instead of sending them. Nothing is written to the console. When
 * `EMAIL_OUTBOX_FILE` is set (the e2e run does this, so a browser test can read the mail the server
 * "sent") each message is also appended to that file as one JSON line.
 */
export class LogEmailSender implements EmailSender {
  async send(message: EmailMessage) {
    outbox.push({ ...message });
    const file = process.env.EMAIL_OUTBOX_FILE;
    if (file) appendFileSync(file, `${JSON.stringify(message)}\n`);
  }
}
