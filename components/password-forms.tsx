"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { InlineError, TextField } from "@/components/ui/field";
import { LogoutButton } from "@/components/logout-button";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/credentials";
import { useT } from "@/lib/i18n/client";

/** Posts JSON and returns an error message, or null on success. */
function useSubmit(path: string) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(payload: unknown): Promise<boolean> {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (response.ok) return true;
      const body = await response.json().catch(() => null);
      setError(body?.error ?? t("error.server"));
    } catch {
      setError(t("error.network"));
    } finally {
      setPending(false);
    }
    return false;
  }

  return { error, pending, submit };
}

export function ForgotForm() {
  const t = useT();
  const { error, pending, submit } = useSubmit("/api/auth/forgot");
  const [sent, setSent] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (await submit({ email: form.get("email") })) setSent(true);
  }

  if (sent) {
    return (
      <main id="main" className="entry-page">
        <h1>{t("forgot.sentTitle")}</h1>
        <p className="entry-lead" role="status">
          {t("forgot.sentBody")}
        </p>
        <Link href="/login" className="ui-button" data-variant="secondary">
          {t("forgot.back")}
        </Link>
      </main>
    );
  }

  return (
    <main id="main" className="entry-page">
      <h1>{t("forgot.title")}</h1>
      <p className="entry-lead">{t("forgot.lead")}</p>
      <form method="post" onSubmit={onSubmit} className="entry-form">
        <TextField label={t("auth.email")} name="email" type="email" autoComplete="email" required />
        {error && <InlineError>{error}</InlineError>}
        <Button type="submit" variant="primary" busy={pending}>
          {pending ? t("auth.pending") : t("forgot.submit")}
        </Button>
      </form>
      <p className="entry-alt">
        <Link href="/login">{t("forgot.back")}</Link>
      </p>
    </main>
  );
}

export function ResetForm({ token }: { token: string }) {
  const router = useRouter();
  const t = useT();
  const { error, pending, submit } = useSubmit("/api/auth/reset");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (await submit({ token, password: form.get("password") })) {
      router.push("/dashboard");
      router.refresh();
    }
  }

  return (
    <main id="main" className="entry-page">
      <h1>{t("reset.title")}</h1>
      <p className="entry-lead">{t("reset.lead")}</p>
      <form method="post" onSubmit={onSubmit} className="entry-form">
        <TextField
          label={t("account.password.new")}
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          hint={t("auth.passwordHint")}
          required
        />
        {error && <InlineError>{error}</InlineError>}
        <Button type="submit" variant="primary" busy={pending}>
          {pending ? t("auth.pending") : t("reset.submit")}
        </Button>
      </form>
      <p className="entry-alt">
        <Link href="/forgot">{t("reset.requestNew")}</Link>
      </p>
    </main>
  );
}

export function ChangePasswordForm({ forced }: { forced: boolean }) {
  const router = useRouter();
  const t = useT();
  const { error, pending, submit } = useSubmit("/api/auth/password");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (await submit({ currentPassword: form.get("currentPassword"), newPassword: form.get("newPassword") })) {
      router.push("/dashboard");
      router.refresh();
    }
  }

  return (
    <main id="main" className="entry-page">
      <h1>{t("account.password.title")}</h1>
      <p className="entry-lead">{forced ? t("account.password.forcedLead") : t("account.password.lead")}</p>
      <form method="post" onSubmit={onSubmit} className="entry-form">
        <TextField
          label={t("account.password.current")}
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
        />
        <TextField
          label={t("account.password.new")}
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          hint={t("auth.passwordHint")}
          required
        />
        {error && <InlineError>{error}</InlineError>}
        <Button type="submit" variant="primary" busy={pending}>
          {pending ? t("auth.pending") : t("account.password.submit")}
        </Button>
      </form>
      {forced && (
        <p className="entry-alt">
          <LogoutButton />
        </p>
      )}
    </main>
  );
}
