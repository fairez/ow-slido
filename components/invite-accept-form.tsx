"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { InlineError, TextField } from "@/components/ui/field";
import { LogoutButton } from "@/components/logout-button";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/credentials";
import { useT } from "@/lib/i18n/client";

export function InviteAcceptForm({ token, signedInEmail }: { token: string; signedInEmail: string | null }) {
  const router = useRouter();
  const t = useT();
  const [error, setError] = useState<{ message: string; reason?: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = signedInEmail ? undefined : String(new FormData(event.currentTarget).get("password"));
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/invitations/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (response.ok) {
        router.push("/dashboard");
        router.refresh();
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: string; reason?: string } | null;
      setError({ message: body?.error ?? t("error.server"), reason: body?.reason });
    } catch {
      setError({ message: t("error.network") });
    } finally {
      setPending(false);
    }
  }

  return (
    <main id="main" className="entry-page">
      <h1>{t("invite.page.title")}</h1>
      <p className="entry-lead">
        {signedInEmail ? t("invite.page.leadSignedIn", { email: signedInEmail }) : t("invite.page.leadNew")}
      </p>
      <form method="post" onSubmit={onSubmit} className="entry-form">
        {signedInEmail ? null : (
          <TextField
            label={t("account.password.new")}
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            hint={t("auth.passwordHint")}
            required
          />
        )}
        {error && <InlineError>{error.message}</InlineError>}
        <Button type="submit" variant="primary" busy={pending}>
          {pending ? t("auth.pending") : signedInEmail ? t("invite.page.accept") : t("invite.page.create")}
        </Button>
      </form>
      {error?.reason === "login_required" && (
        <div className="entry-alt">
          <p>{t("invite.page.loginThenReturn")}</p>
          <Link href="/login" className="ui-button" data-variant="secondary">
            {t("invite.page.login")}
          </Link>
        </div>
      )}
      {error?.reason === "wrong_email" && (
        <p className="entry-alt">
          <LogoutButton />
        </p>
      )}
    </main>
  );
}
