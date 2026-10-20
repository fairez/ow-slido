import nodemailer, { type Transporter } from "nodemailer";
import type { EmailMessage, EmailSender } from "./types";

export class SmtpEmailSender implements EmailSender {
  private transport: Transporter;
  private from: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const host = env.SMTP_HOST;
    const from = env.EMAIL_FROM;
    if (!host || !from) throw new Error("SMTP_HOST and EMAIL_FROM are required when EMAIL_PROVIDER=smtp");
    const port = Number(env.SMTP_PORT) || 587;
    this.from = from;
    this.transport = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? "" } : undefined,
    });
  }

  async send(message: EmailMessage) {
    await this.transport.sendMail({ from: this.from, to: message.to, subject: message.subject, text: message.text });
  }
}
