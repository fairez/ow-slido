"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { InlineError, TextField } from "@/components/ui/field";
import { useT } from "@/lib/i18n/client";

type Mode = "login" | "signup";

const ALT_HREF = { login: "/signup", signup: "/login" } as const;

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      if (response.ok) {
        router.push("/dashboard");
        router.refresh();
        return;
      }
      const body = await response.json().catch(() => null);
      setError(body?.error ?? t("error.server"));
    } catch {
      setError(t("error.network"));
    } finally {
      setPending(false);
    }
  }

  return (
    <main id="main" className="entry-page">
      <h1>{t(`auth.${mode}.title`)}</h1>
      <p className="entry-lead">{t(`auth.${mode}.lead`)}</p>
      <form method="post" onSubmit={onSubmit} className="entry-form">
        <TextField label={t("auth.email")} name="email" type="email" autoComplete="email" required />
        <TextField
          label={t("auth.password")}
          name="password"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          minLength={mode === "signup" ? 8 : undefined}
          hint={mode === "signup" ? t("auth.passwordHint") : undefined}
          required
        />
        {error && <InlineError>{error}</InlineError>}
        <Button type="submit" variant="primary" busy={pending}>
          {pending ? t("auth.pending") : t(`auth.${mode}.submit`)}
        </Button>
      </form>
      {mode === "login" && (
        <p className="entry-alt entry-forgot">
          <Link href="/forgot">{t("auth.forgotLink")}</Link>
        </p>
      )}
      <p className="entry-alt">
        {t(`auth.${mode}.alt`)} <Link href={ALT_HREF[mode]}>{t(`auth.${mode}.altLink`)}</Link>
      </p>
    </main>
  );
}
