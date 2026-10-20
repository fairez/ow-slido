import { LogEmailSender } from "./log";
import { SmtpEmailSender } from "./smtp";
import type { EmailSender } from "./types";

export type { EmailMessage, EmailSender } from "./types";
export { clearOutbox, getOutbox } from "./log";

let sender: EmailSender | null = null;

/** `EMAIL_PROVIDER=smtp` sends for real; anything else (the default) uses the in-memory log adapter. */
export function getEmailSender(): EmailSender {
  if (!sender) sender = process.env.EMAIL_PROVIDER === "smtp" ? new SmtpEmailSender() : new LogEmailSender();
  return sender;
}

/** Test hook: drop the cached adapter so the next call re-reads the environment. */
export function resetEmailSender() {
  sender = null;
}
