"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { InlineError, TextField } from "@/components/ui/field";
import { NETWORK_ERROR, SERVER_ERROR } from "@/lib/copy";
import { goTo } from "@/lib/go-to";
import { useT } from "@/lib/i18n/client";

type Blocking = { id: string; name: string };

/** Password-confirmed account deletion. A 409 lists the workspaces whose ownership has to move first. */
export function DeleteAccount() {
  const t = useT();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocking, setBlocking] = useState<Blocking[]>([]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    setPending(true);
    setError(null);
    setBlocking([]);
    try {
      const response = await fetch("/api/auth/account", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (response.ok) {
        goTo("/");
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: unknown; workspaces?: Blocking[] } | null;
      setError(typeof body?.error === "string" ? body.error : SERVER_ERROR);
      if (response.status === 409 && Array.isArray(body?.workspaces)) setBlocking(body.workspaces);
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="entry-form">
      <TextField label={t("account.delete.password")} name="password" type="password" autoComplete="current-password" required />
      {error && <InlineError>{error}</InlineError>}
      {blocking.length > 0 && (
        <div className="delete-account-blocking">
          <p>{t("account.delete.blocking")}</p>
          <ul>
            {blocking.map((w) => (
              <li key={w.id}>{w.name}</li>
            ))}
          </ul>
        </div>
      )}
      <Button type="submit" variant="primary" busy={pending}>
        {pending ? t("auth.pending") : t("account.delete.submit")}
      </Button>
    </form>
  );
}
