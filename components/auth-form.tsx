"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { InlineError, TextField } from "@/components/ui/field";
import { useT } from "@/lib/i18n/client";

type Mode = "login" | "signup";

const ALT_HREF = { login: "/signup", signup: "/login" } as const;

/** Second step of a login with 2FA. The pending token stays in memory; it is never put in the URL. */
function TwoFactorStep({ pendingToken, onBack }: { pendingToken: string; onBack: () => void }) {
  const router = useRouter();
  const t = useT();
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const fieldRef = useRef<HTMLDivElement>(null);

  // Put the cursor in the field when the step opens and when the kind of code changes.
  useEffect(() => {
    fieldRef.current?.querySelector("input")?.focus();
  }, [recovery]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/2fa/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pendingToken, code: form.get("code") }),
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
      <h1>{t("auth.twoFactor.title")}</h1>
      <p className="entry-lead">{recovery ? t("auth.twoFactor.recoveryLead") : t("auth.twoFactor.lead")}</p>
      <form method="post" onSubmit={onSubmit} className="entry-form">
        <div ref={fieldRef}>
          {recovery ? (
            <TextField
              key="recovery"
              label={t("auth.twoFactor.recoveryLabel")}
              hint={t("auth.twoFactor.recoveryHint")}
              name="code"
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="code-input"
              required
            />
          ) : (
            <TextField
              key="code"
              label={t("auth.twoFactor.codeLabel")}
              hint={t("auth.twoFactor.codeHint")}
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              spellCheck={false}
              className="code-input"
              required
            />
          )}
        </div>
        {error && <InlineError>{error}</InlineError>}
        <Button type="submit" variant="primary" busy={pending}>
          {pending ? t("auth.pending") : t("auth.twoFactor.submit")}
        </Button>
      </form>
      <p className="entry-alt entry-forgot">
        <Button
          variant="quiet"
          onClick={() => {
            setRecovery((value) => !value);
            setError(null);
          }}
        >
          {recovery ? t("auth.twoFactor.useApp") : t("auth.twoFactor.useRecovery")}
        </Button>
      </p>
      <p className="entry-alt">
        <Button variant="quiet" onClick={onBack}>
          {t("auth.twoFactor.back")}
        </Button>
      </p>
    </main>
  );
}

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [pendingToken, setPendingToken] = useState<string | null>(null);

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
      const body = await response.json().catch(() => null);
      if (response.ok) {
        if (body?.twoFactorRequired && typeof body.pendingToken === "string") {
          setPendingToken(body.pendingToken);
          return;
        }
        router.push("/dashboard");
        router.refresh();
        return;
      }
      setError(body?.error ?? t("error.server"));
    } catch {
      setError(t("error.network"));
    } finally {
      setPending(false);
    }
  }

  if (pendingToken) return <TwoFactorStep pendingToken={pendingToken} onBack={() => setPendingToken(null)} />;

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
