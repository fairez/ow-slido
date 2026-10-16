"use client";

import { useState } from "react";
import { LiveView } from "@/components/live-view";
import { QaTab } from "@/components/qa-tab";
import type { LiveInteraction } from "@/lib/live-view";
import type { PublicQuestion } from "@/lib/question-types";

/** Participant page body: a "Live" tab for polls and word clouds, and a "Q&A" tab. Both stay mounted so they keep listening. */
export function ParticipantView({
  eventId,
  initial,
  initialQuestions,
}: {
  eventId: string;
  initial: LiveInteraction | null;
  initialQuestions: PublicQuestion[];
}) {
  const [tab, setTab] = useState<"live" | "qa">("live");
  return (
    <>
      <div role="tablist" aria-label="Event sections" className="tabs">
        <button role="tab" id="tab-live" aria-selected={tab === "live"} aria-controls="panel-live" onClick={() => setTab("live")} className="tab">
          Live
        </button>
        <button role="tab" id="tab-qa" aria-selected={tab === "qa"} aria-controls="panel-qa" onClick={() => setTab("qa")} className="tab">
          Q&amp;A
        </button>
      </div>
      <div role="tabpanel" id="panel-live" aria-labelledby="tab-live" hidden={tab !== "live"}>
        <LiveView eventId={eventId} initial={initial} />
      </div>
      <div role="tabpanel" id="panel-qa" aria-labelledby="tab-qa" hidden={tab !== "qa"}>
        <QaTab eventId={eventId} initial={initialQuestions} />
      </div>
    </>
  );
}
