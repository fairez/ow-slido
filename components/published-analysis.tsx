"use client";

import { AnalysisSummary } from "@/components/analysis-summary";
import { useCallback, useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import { WordCloud } from "@/components/word-cloud";
import { useT } from "@/lib/i18n/client";
import type { PublicAnalysis } from "@/lib/note-analysis";

type Props = { interactionId: string; socket: Socket | null };

/** Participant view of the analysis the host chose to publish: summary, categories with counts, word cloud. */
export function PublishedAnalysis({ interactionId, socket }: Props) {
  const t = useT();
  const [analysis, setAnalysis] = useState<PublicAnalysis | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/interactions/${interactionId}/analysis/published`);
      if (!res.ok) return;
      setAnalysis(((await res.json()) as { analysis: PublicAnalysis | null }).analysis);
    } catch {
      // Offline: the next reconnect reloads.
    }
  }, [interactionId]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  useEffect(() => {
    if (!socket) return;
    const onPublished = (msg: { interactionId: string; analysis: PublicAnalysis | null }) => {
      if (msg.interactionId === interactionId) setAnalysis(msg.analysis);
    };
    socket.on("analysis:published", onPublished);
    socket.on("connect", load);
    return () => {
      socket.off("analysis:published", onPublished);
      socket.off("connect", load);
    };
  }, [socket, interactionId, load]);

  if (!analysis) return null;
  const words = analysis.keywords.map((k) => ({
    word: k.word,
    count: Math.max(1, Math.round(k.weight)),
  }));

  return (
    <section aria-labelledby="published-analysis-title" className="analysis-card">
      <h3 id="published-analysis-title">{t("analysis.title")}</h3>
      <p className="analysis-muted">{t("analysis.byline")}</p>
      {analysis.summary && <AnalysisSummary text={analysis.summary} className="analysis-summary" />}
      {analysis.categories.length > 0 && (
        <ul aria-label={t("analysis.categories")} className="analysis-list">
          {analysis.categories.map((c) => (
            <li key={c.name}>
              <strong>{c.name}</strong>:{" "}
              {t(c.count === 1 ? "analysis.notes.one" : "analysis.notes.other", { n: c.count })}
              {c.description && <div className="analysis-muted">{c.description}</div>}
            </li>
          ))}
        </ul>
      )}
      {words.length > 0 && <WordCloud words={words} sizeRange={[1, 2.25]} />}
    </section>
  );
}
