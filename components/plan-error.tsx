"use client";

import { InlineError } from "@/components/ui/field";
import { PlanHint } from "@/components/plan-hint";
import type { ApiError } from "@/lib/api-error";

/** An API error shown inline; a plan limit also gets the link that names the tier which lifts it. */
export function PlanError({ error, unlock }: { error: ApiError; unlock: string }) {
  return (
    <>
      <InlineError>{error.message}</InlineError>
      {error.lock && (
        <p>
          <PlanHint lock={error.lock}>{unlock}</PlanHint>
        </p>
      )}
    </>
  );
}
