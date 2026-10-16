"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

type Mode = "login" | "signup";

const COPY = {
  login: { title: "Log in", submit: "Log in", alt: "Need an account?", altLink: "Sign up", altHref: "/signup" },
  signup: { title: "Sign up", submit: "Create account", alt: "Already have an account?", altLink: "Log in", altHref: "/login" },
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
    <main style={{ maxWidth: 400, margin: "0 auto", padding: 16 }}>
      <h1>{copy.title}</h1>
      <form method="post" onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 4 }}>
          Email
          <input name="email" type="email" autoComplete="email" required style={{ padding: 8, font: "inherit" }} />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          Password
          <input
            name="password"
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            minLength={mode === "signup" ? 8 : undefined}
            required
            style={{ padding: 8, font: "inherit" }}
          />
        </label>
        {error && (
          <p role="alert" style={{ color: "#b00020", margin: 0 }}>
            {error}
          </p>
        )}
        <button type="submit" disabled={pending} style={{ padding: 10, font: "inherit" }}>
          {pending ? "Please wait…" : copy.submit}
        </button>
      </form>
      <p>
        {copy.alt} <Link href={copy.altHref}>{copy.altLink}</Link>
      </p>
    </main>
  );
}
