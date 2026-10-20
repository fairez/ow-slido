"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TypedConfirmDialog } from "@/components/typed-confirm-dialog";
import { NETWORK_ERROR } from "@/lib/copy";
import { apiError } from "@/lib/api-error";
import { goTo } from "@/lib/go-to";
import { useT } from "@/lib/i18n/client";

/** Owner-only danger zone: deletes the whole workspace after its name is typed. */
export function DeleteWorkspace({ name }: { name: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  async function confirm(): Promise<string | null> {
    try {
      const response = await fetch("/api/workspaces/active", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) return (await apiError(response)).message;
      goTo("/dashboard");
      return null;
    } catch {
      return NETWORK_ERROR;
    }
  }

  return (
    <section aria-labelledby="delete-workspace-heading" className="member-policy danger-zone">
      <h2 id="delete-workspace-heading">{t("settings.delete.title")}</h2>
      <p className="row-meta">{t("settings.delete.lead", { name })}</p>
      <Button onClick={() => setOpen(true)}>{t("settings.delete.button")}</Button>
      <TypedConfirmDialog
        open={open}
        title={t("settings.delete.dialogTitle")}
        body={t("settings.delete.dialogBody", { name })}
        expected={name}
        confirmLabel={t("settings.delete.confirm")}
        onConfirm={confirm}
        onClose={() => setOpen(false)}
      />
    </section>
  );
}
