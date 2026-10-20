"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n";

type WorkspaceOption = { id: string; name: string; role: string };

export function WorkspaceSwitcher({ workspaces, activeId }: { workspaces: WorkspaceOption[]; activeId: string }) {
  const t = useT();
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const roleLabel = (role: string) => t(`role.${role}` as MessageKey);
  const active = workspaces.find((w) => w.id === activeId) ?? workspaces[0];
  if (!active) return null;

  async function switchTo(workspaceId: string) {
    setFailed(false);
    const res = await fetch("/api/workspaces/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    if (!res.ok) {
      setFailed(true);
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  if (workspaces.length === 1) {
    return (
      <p className="workspace-current">
        <span className="workspace-name">{active.name}</span>
        <span className="workspace-role">{roleLabel(active.role)}</span>
      </p>
    );
  }

  return (
    <div className="workspace-switcher">
      <select
        aria-label={t("workspace.switch")}
        value={active.id}
        onChange={(e) => void switchTo(e.target.value)}
      >
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {t("workspace.option", { name: w.name, role: roleLabel(w.role) })}
          </option>
        ))}
      </select>
      {failed ? (
        <span role="alert" className="workspace-error">
          {t("workspace.switchFailed")}
        </span>
      ) : null}
    </div>
  );
}
