"use client";

import { TypeIcon } from "@/components/type-icon";
import type { TemplateSummary } from "@/components/template-types";
import { useT } from "@/lib/i18n/client";
import { TYPE_LABELS } from "@/lib/type-labels";

/** The items a template holds, in order, each with its type icon and name. */
export function TemplateItems({ template }: { template: TemplateSummary }) {
  const t = useT();
  return (
    <ul className="template-items" aria-label={t("templates.itemsOf", { name: template.name })}>
      {template.items.map((item, index) => (
        <li key={index}>
          <span className="type-tag"><TypeIcon kind={item.type} /> {t(TYPE_LABELS[item.type])}</span>
          <span className="template-item-title">{item.title}</span>
        </li>
      ))}
    </ul>
  );
}
