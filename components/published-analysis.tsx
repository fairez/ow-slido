"use client";

import { useCallback, useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import { WordCloud } from "@/components/word-cloud";
import type { PublicAnalysis } from "@/lib/note-analysis";

type Props = { interactionId: string; socket: Socket | null };

/** Participant view of the analysis the host chose to publish: summary, categories with counts, word cloud. */
export function PublishedAnalysis({ interactionId, socket }: Props) {
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
  const words = analysis.keywords.map((k) => ({ word: k.word, count: Math.max(1, Math.round(k.weight)) }));

  return (
    <section
      aria-labelledby="published-analysis-title"
      style={{ border: "1px solid var(--border, #8a8178)", borderRadius: 8, padding: 12, display: "grid", gap: 12 }}
    >
      <h3 id="published-analysis-title" style={{ margin: 0 }}>
        Themes from the notes
      </h3>
      <p style={{ margin: 0, fontSize: "0.875rem" }}>Written by an AI service and reviewed by the host.</p>
      {analysis.summary && <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{analysis.summary}</p>}
      {analysis.categories.length > 0 && (
        <ul aria-label="Categories" style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
          {analysis.categories.map((c) => (
            <li key={c.name}>
              <strong>{c.name}</strong>: {c.count} {c.count === 1 ? "note" : "notes"}
              {c.description && <div style={{ fontSize: "0.875rem" }}>{c.description}</div>}
            </li>
          ))}
        </ul>
      )}
      {words.length > 0 && <WordCloud words={words} sizeRange={[1, 2.25]} />}
    </section>
  );
}
