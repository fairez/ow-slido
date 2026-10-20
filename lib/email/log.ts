import type { EmailMessage, EmailSender } from "./types";

const outbox: EmailMessage[] = [];

/** Messages captured by the log adapter, oldest first. Lives in memory only. */
export function getOutbox(): readonly EmailMessage[] {
  return outbox;
}

export function clearOutbox() {
  outbox.length = 0;
}

/** Keeps messages in memory instead of sending them. Nothing is written to disk or the console. */
export class LogEmailSender implements EmailSender {
  async send(message: EmailMessage) {
    outbox.push({ ...message });
  }
}
