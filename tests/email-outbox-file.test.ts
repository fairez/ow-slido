// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { clearOutbox, getOutbox } from "@/lib/email";
import { LogEmailSender } from "@/lib/email/log";

afterEach(() => {
  vi.unstubAllEnvs();
  clearOutbox();
});

test("without EMAIL_OUTBOX_FILE the log adapter keeps mail in memory only", async () => {
  vi.stubEnv("EMAIL_OUTBOX_FILE", "");
  await new LogEmailSender().send({ to: "a@example.com", subject: "Hi", text: "Body" });
  expect(getOutbox()).toEqual([{ to: "a@example.com", subject: "Hi", text: "Body" }]);
});

test("with EMAIL_OUTBOX_FILE each message is also appended as one JSON line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "outbox-"));
  try {
    const file = join(dir, "outbox.jsonl");
    vi.stubEnv("EMAIL_OUTBOX_FILE", file);
    const sender = new LogEmailSender();
    await sender.send({ to: "a@example.com", subject: "One", text: "Line\nbreak" });
    await sender.send({ to: "b@example.com", subject: "Two", text: "Second" });

    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { to: "a@example.com", subject: "One", text: "Line\nbreak" },
      { to: "b@example.com", subject: "Two", text: "Second" },
    ]);
    expect(getOutbox()).toHaveLength(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
