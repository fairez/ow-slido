"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { InlineError } from "@/components/ui/field";
import { apiError } from "@/lib/api-error";
import { NETWORK_ERROR } from "@/lib/copy";
import { useLocale, useT } from "@/lib/i18n/client";

export type OpsAiData = {
  provider: "openai" | "openrouter" | "mock" | null;
  model: string | null;
  configured: boolean;
  callsToday: number;
  globalDailyCap: number;
  paused: boolean;
};

/** Which AI provider and model the platform uses, today's calls against the global cap, and a connection check. */
export function OpsAiPanel({ initial }: { initial: OpsAiData }) {
  const t = useT();
  const locale = useLocale();
  const [data, setData] = useState(initial);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const numbers = new Intl.NumberFormat(locale);

  async function test() {
    if (testing) return;
    setTesting(true);
    setResult(null);
    try {
      const response = await fetch("/api/ai/test", { method: "POST" });
      if (response.ok) setResult({ ok: true, text: t("ops.ai.testOk") });
      else setResult({ ok: false, text: (await apiError(response)).message });
      // The check is a call too, so the count moves.
      const fresh = await fetch("/api/ops/ai");
      if (fresh.ok) setData((await fresh.json()) as OpsAiData);
    } catch {
      setResult({ ok: false, text: NETWORK_ERROR });
    }
    setTesting(false);
  }

  return (
    <section className="ops-panel" aria-labelledby="ops-ai-title">
      <div className="ops-row-head">
        <h2 id="ops-ai-title">{t("ops.ai.title")}</h2>
        {data.paused && <Badge tone="accent">{t("ops.ai.paused")}</Badge>}
      </div>
      {data.provider ? (
        <dl className="ops-facts ops-ai-facts">
          <div>
            <dt>{t("ops.ai.provider")}</dt>
            <dd>{data.provider}</dd>
          </div>
          <div>
            <dt>{t("ops.ai.model")}</dt>
            <dd>{data.model}</dd>
          </div>
          <div>
            <dt>{t("ops.ai.today")}</dt>
            <dd>{t("ops.ai.todayOf", { used: numbers.format(data.callsToday), cap: numbers.format(data.globalDailyCap) })}</dd>
          </div>
        </dl>
      ) : (
        <p className="row-meta">{t("ops.ai.none")}</p>
      )}
      {data.provider && !data.configured && <p className="row-meta">{t("ops.ai.noKey")}</p>}
      <div className="row-actions">
        <Button onClick={test} aria-busy={testing || undefined} aria-disabled={!data.configured || undefined}>
          {t("ops.ai.test")}
        </Button>
      </div>
      <div role="status" aria-live="polite">
        {result && !result.ok ? <InlineError>{result.text}</InlineError> : result ? <p className="ops-notice">{result.text}</p> : null}
      </div>
    </section>
  );
}
