"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { joinEvent } from "@/lib/join-client";

export function JoinForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code") ?? "").trim();
    setPending(true);
    setError(null);
    const result = await joinEvent(code);
    if (result.ok) {
      router.push(`/e/${result.eventId}`);
      return;
    }
    setError(result.error);
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
      <label style={{ display: "grid", gap: 4 }}>
        Event code
        <input
          name="code"
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          required
          style={{ minHeight: 44, padding: 8, font: "inherit", fontSize: 18 }}
        />
      </label>
      {error && (
        <p role="alert" style={{ color: "#b00020", margin: 0 }}>
          {error}
        </p>
      )}
      <button type="submit" disabled={pending} style={{ minHeight: 44, padding: 10, font: "inherit" }}>
        {pending ? "Joining…" : "Join"}
      </button>
    </form>
  );
}
