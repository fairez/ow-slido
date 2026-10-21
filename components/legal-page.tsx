import type { ReactNode } from "react";
import type { LegalSection } from "@/lib/legal";
import type { MessageKey, TParams } from "@/lib/i18n";

type Translate = (key: MessageKey, params?: TParams) => string;

/** Shared body of /terms and /privacy. The banner is what `tests/legal.test.ts` guards until docs/legal/REVIEWED exists. */
export function LegalPage({
  title,
  lead,
  sections,
  t,
  params,
}: {
  title: string;
  lead: string;
  sections: LegalSection[];
  t: Translate;
  params?: TParams;
}): ReactNode {
  return (
    <main id="main" className="legal-page">
      <h1>{title}</h1>
      <p className="legal-lead">{lead}</p>
      <div className="legal-banner" role="note" data-legal-placeholder>
        <p className="legal-banner-title">{t("legal.banner")}</p>
        <p>{t("legal.bannerNote")}</p>
      </div>
      {sections.map((section) => (
        <section key={section.heading} className="legal-section" aria-labelledby={`legal-${section.heading}`}>
          <h2 id={`legal-${section.heading}`}>{t(section.heading)}</h2>
          {section.paragraphs?.map((key) => (
            <p key={key}>{t(key, params)}</p>
          ))}
          {section.items ? (
            <ul>
              {section.items.map((key) => (
                <li key={key}>{t(key, params)}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
    </main>
  );
}
