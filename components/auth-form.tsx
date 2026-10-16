"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { InlineError, TextField } from "@/components/ui/field";

type Mode = "login" | "signup";

const COPY = {
  login: { title: "Log in", lead: "Welcome back. Log in to manage your events.", submit: "Log in", alt: "Need an account?", altLink: "Sign up", altHref: "/signup" },
  signup: { title: "Create a host account", lead: "An email and a password are all you need to start an event.", submit: "Create account", alt: "Already have an account?", altLink: "Log in", altHref: "/login" },
} as const;

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const copy = COPY[mode];
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
      setError(body?.error ?? "Something went wrong. Please try again.");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main id="main" className="entry-page">
      <h1>{copy.title}</h1>
      <p className="entry-lead">{copy.lead}</p>
      <form method="post" onSubmit={onSubmit} className="entry-form">
        <TextField label="Email" name="email" type="email" autoComplete="email" required />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          minLength={mode === "signup" ? 8 : undefined}
          hint={mode === "signup" ? "At least 8 characters." : undefined}
          required
        />
        {error && <InlineError>{error}</InlineError>}
        <Button type="submit" variant="primary" busy={pending}>
          {pending ? "One moment" : copy.submit}
        </Button>
      </form>
      <p className="entry-alt">
        {copy.alt} <Link href={copy.altHref}>{copy.altLink}</Link>
      </p>
    </main>
  );
}
