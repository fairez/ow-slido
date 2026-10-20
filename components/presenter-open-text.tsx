"use client";

import { useT } from "@/lib/i18n/client";
import type { PublicResponse } from "@/lib/open-text";

/** Responses for the projector, newest first; highlighted ones get an accent border and a label. */
export function PresenterOpenText({ responses, closed }: { responses: PublicResponse[]; closed: boolean }) {
  const t = useT();
  const ordered = [...responses].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <>
      <p className="present-total">
        {t(responses.length === 1 ? "presOpenText.count.one" : "presOpenText.count.other", { n: responses.length })}
        {closed ? t("presOpenText.closed") : ""}
      </p>
      {ordered.length === 0 ? (
        <p role="status" className="present-empty">
          {t("presOpenText.empty")}
        </p>
      ) : (
        <ul aria-label={t("presOpenText.listLabel")} className="present-cards">
          {ordered.map((r) => (
            <li key={r.id} className="present-card" data-highlight={r.highlighted || undefined}>
              {r.highlighted && <p className="present-card-label">{t("presOpenText.highlighted")}</p>}
              <p className="present-card-text">{r.text}</p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
