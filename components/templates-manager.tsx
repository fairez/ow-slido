"use client";

import { useState, type FormEvent } from "react";
import { PlanHint } from "@/components/plan-hint";
import { TemplateItems } from "@/components/template-items";
import type { TemplateSummary } from "@/components/template-types";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { InlineError, TextField } from "@/components/ui/field";
import { apiError } from "@/lib/api-error";
import { NETWORK_ERROR } from "@/lib/copy";
import { useT } from "@/lib/i18n/client";
import type { Lock } from "@/lib/plan-hints";
import { TEMPLATE_NAME_MAX } from "@/lib/template-limits";

/** The workspace's templates: everyone reads them, owners and admins rename and delete. */
export function TemplatesManager({ initialTemplates, limit, canManage, limitLock }: { initialTemplates: TemplateSummary[]; limit: number; canManage: boolean; limitLock?: Lock }) {
  const t = useT();
  const [list, setList] = useState(initialTemplates);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TemplateSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function request(url: string, init: RequestInit) {
    setError(null);
    try {
      const response = await fetch(url, init);
      if (response.ok) return response;
      setError((await apiError(response)).message);
    } catch {
      setError(NETWORK_ERROR);
    }
    return null;
  }

  async function rename(target: TemplateSummary, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name"));
    const response = await request(`/api/templates/${target.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!response) return;
    const { template } = (await response.json()) as { template: { name: string } };
    setList((all) => all.map((item) => (item.id === target.id ? { ...item, name: template.name } : item)));
    setRenaming(null);
  }

  async function confirmDelete(target: TemplateSummary) {
    const response = await request(`/api/templates/${target.id}`, { method: "DELETE" });
    setDeleting(null);
    if (response) setList((all) => all.filter((item) => item.id !== target.id));
  }

  const full = list.length >= limit;

  return (
    <div className="stack">
      <p className="row-meta" data-testid="template-usage">
        {t("templates.usage", { used: list.length, limit })}
        {full && limitLock && (
          <>
            {" "}
            <PlanHint lock={limitLock}>{t("templates.moreTemplates")}</PlanHint>
          </>
        )}
      </p>
      {!canManage && <p className="row-meta">{t("templates.managedByAdmins")}</p>}
      {error && <InlineError>{error}</InlineError>}
      {list.length === 0 ? (
        <EmptyState title={t("templates.emptyTitle")}>{t("templates.emptyBody")}</EmptyState>
      ) : (
        <ul className="row-list" aria-label={t("templates.listLabel")}>
          {list.map((template) => (
            <li key={template.id} className="template-row">
              <div className="event-main">
                {renaming === template.id ? (
                  <form onSubmit={(e) => rename(template, e)} className="inline-form">
                    <TextField label={t("templates.renameField")} name="name" defaultValue={template.name} required maxLength={TEMPLATE_NAME_MAX} />
                    <Button type="submit" variant="primary">{t("templates.renameSave")}</Button>
                    <Button onClick={() => setRenaming(null)}>{t("templates.cancel")}</Button>
                  </form>
                ) : (
                  <h3 className="event-name">{template.name}</h3>
                )}
                <p className="row-meta">
                  <Badge>{t(template.kind === "event" ? "templates.kind.event" : "templates.kind.interaction")}</Badge>{" "}
                  {t(template.items.length === 1 ? "templates.itemCount.one" : "templates.itemCount.other", { count: template.items.length })}
                </p>
                <TemplateItems template={template} />
              </div>
              {canManage && (
                <div className="row-actions row-actions-quiet">
                  <Button variant="quiet" aria-label={t("templates.renameFor", { name: template.name })} onClick={() => { setError(null); setRenaming(template.id); }}>{t("templates.rename")}</Button>
                  <Button variant="quiet" aria-label={t("templates.deleteFor", { name: template.name })} onClick={() => setDeleting(template)}>{t("templates.delete")}</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={deleting !== null} title={t("templates.deleteTitle")} onClose={() => setDeleting(null)}>
        <p>{t("templates.deleteBody", { name: deleting?.name ?? "" })}</p>
        <div className="row-actions">
          <Button onClick={() => setDeleting(null)}>{t("templates.cancel")}</Button>
          <Button variant="primary" onClick={() => deleting && confirmDelete(deleting)}>{t("templates.deleteConfirm")}</Button>
        </div>
      </Dialog>
    </div>
  );
}
