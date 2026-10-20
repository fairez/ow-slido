"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PlanHint } from "@/components/plan-hint";
import { TypeIcon, type IconKind } from "@/components/type-icon";
import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n";
import type { Lock } from "@/lib/plan-hints";

export type AddEntry = { kind: IconKind; label: MessageKey };

/**
 * One "Add content" button that opens the list of every type. A type the plan leaves out stays in
 * the list as a link naming the tier that unlocks it.
 */
export function AddContentMenu({
  entries,
  locks,
  onPick,
}: {
  entries: AddEntry[];
  locks: Partial<Record<IconKind, Lock>>;
  onPick: (kind: IconKind) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointer = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <div className="add-menu" ref={root}>
      <Button variant="primary" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((v) => !v)}>
        {t("pollMgr.addContent")}
      </Button>
      {open && (
        <ul id={menuId} className="add-menu-list" aria-label={t("pollMgr.addContentTypes")}>
          {entries.map(({ kind, label }) => {
            const lock = locks[kind];
            return (
              <li key={kind}>
                {lock ? (
                  <PlanHint lock={lock}>
                    <TypeIcon kind={kind} /> {t(label)}
                  </PlanHint>
                ) : (
                  <Button
                    onClick={() => {
                      setOpen(false);
                      onPick(kind);
                    }}
                  >
                    <TypeIcon kind={kind} /> {t(label)}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
