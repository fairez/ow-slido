"use client";

import { useState, type FormEvent } from "react";
import { PlanError } from "@/components/plan-error";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { InlineError, TextField } from "@/components/ui/field";
import type { TemplateSummary } from "@/components/template-types";
import { apiError, type ApiError } from "@/lib/api-error";
import { NETWORK_ERROR } from "@/lib/copy";
import { useT } from "@/lib/i18n/client";
import { TEMPLATE_NAME_MAX } from "@/lib/template-limits";

/** What to save: one item of the event, or (no `interactionId`) its whole list. */
export type SaveTarget = { interactionId?: string; defaultName: string };

function SaveForm({ eventId, target, onClose, onSaved }: { eventId: string; target: SaveTarget; onClose: () => void; onSaved: (template: Pick<TemplateSummary, "id" | "name">) => void }) {
  const t = useT();
  const [name, setName] = useState(target.defaultName.slice(0, TEMPLATE_NAME_MAX));
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId, interactionId: target.interactionId, name }),
      });
      if (!response.ok) {
        setError(await apiError(response));
        return;
      }
      const { template } = (await response.json()) as { template: Pick<TemplateSummary, "id" | "name"> };
      onSaved(template);
    } catch {
      setError({ message: NETWORK_ERROR, lock: null });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="form-stack">
      <p>{t(target.interactionId ? "templates.saveBodyItem" : "templates.saveBodyEvent")}</p>
      <TextField label={t("templates.nameField")} value={name} onChange={(e) => setName(e.target.value)} required maxLength={TEMPLATE_NAME_MAX} />
      {error && (error.lock ? <PlanError error={error} unlock={t("templates.moreTemplates")} /> : <InlineError>{error.message}</InlineError>)}
      <div className="row-actions">
        {/* Not disabled while saving: a disabled button drops keyboard focus out of the dialog. */}
        <Button type="submit" variant="primary" aria-busy={pending || undefined}>{pending ? t("templates.saving") : t("templates.saveConfirm")}</Button>
        <Button onClick={onClose}>{t("templates.cancel")}</Button>
      </div>
    </form>
  );
}

export function SaveTemplateDialog({ eventId, target, onClose, onSaved }: { eventId: string; target: SaveTarget | null; onClose: () => void; onSaved: (template: Pick<TemplateSummary, "id" | "name">) => void }) {
  const t = useT();
  return (
    <Dialog open={target !== null} title={t("templates.saveTitle")} onClose={onClose}>
      {target && <SaveForm eventId={eventId} target={target} onClose={onClose} onSaved={onSaved} />}
    </Dialog>
  );
}
