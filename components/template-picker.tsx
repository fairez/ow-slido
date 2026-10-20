"use client";

import { useEffect, useState } from "react";
import { PlanError } from "@/components/plan-error";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { InlineError } from "@/components/ui/field";
import { TemplateItems } from "@/components/template-items";
import type { TemplateSummary } from "@/components/template-types";
import { apiError, type ApiError } from "@/lib/api-error";
import { NETWORK_ERROR } from "@/lib/copy";
import { useT } from "@/lib/i18n/client";

type Added = { interactions: unknown[] };

type PickerProps = { eventId: string; canManage: boolean; onClose: () => void; onAdded: (template: TemplateSummary, interactions: unknown[]) => void };

/** Mounted only while the dialog is open, so every opening starts with a fresh load. */
function PickerBody({ eventId, canManage, onClose, onAdded }: PickerProps) {
  const t = useT();
  const [list, setList] = useState<TemplateSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/templates")
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) return setError(await apiError(response));
        setList(((await response.json()) as { templates: TemplateSummary[] }).templates);
      })
      .catch(() => !cancelled && setError({ message: NETWORK_ERROR, lock: null }));
    return () => {
      cancelled = true;
    };
  }, []);

  async function add(template: TemplateSummary) {
    if (adding) return;
    setAdding(template.id);
    setError(null);
    try {
      const response = await fetch(`/api/events/${eventId}/interactions/from-template`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templateId: template.id }),
      });
      if (!response.ok) {
        setError(await apiError(response));
        return;
      }
      onAdded(template, ((await response.json()) as Added).interactions);
    } catch {
      setError({ message: NETWORK_ERROR, lock: null });
    } finally {
      setAdding(null);
    }
  }

  return (
    <>
      <p>{t("templates.pickLead")}</p>
      {error && (error.lock ? <PlanError error={error} unlock={t("pollMgr.unlock")} /> : <InlineError>{error.message}</InlineError>)}
      {list === null && !error && <p role="status" className="row-meta">{t("templates.pickLoading")}</p>}
      {list?.length === 0 && (
        <p role="status">
          {t("templates.pickEmpty")} {canManage && t("templates.pickEmptyManage")}
        </p>
      )}
      {list && list.length > 0 && (
        <ul className="row-list template-pick-list">
          {list.map((template) => (
            <li key={template.id} className="template-row">
              <div className="event-main">
                <h3 className="event-name">{template.name}</h3>
                <TemplateItems template={template} />
              </div>
              <Button variant="primary" aria-label={t("templates.addFor", { name: template.name })} aria-busy={adding === template.id || undefined} onClick={() => add(template)}>
                {t("templates.add")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="row-actions">
        <Button onClick={onClose}>{t("templates.close")}</Button>
      </div>
    </>
  );
}

/** Dialog that lists the workspace's templates and adds one to the event as drafts. */
export function TemplatePicker({ open, ...props }: PickerProps & { open: boolean }) {
  const t = useT();
  return (
    <Dialog open={open} title={t("templates.pickTitle")} onClose={props.onClose}>
      <PickerBody {...props} />
    </Dialog>
  );
}
