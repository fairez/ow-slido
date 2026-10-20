"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { InlineError, Select, TextArea, TextField } from "@/components/ui/field";
import { apiError } from "@/lib/api-error";
import { NETWORK_ERROR } from "@/lib/copy";
import { useLocale, useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n";

type Plan = "free" | "pro" | "team";
type Role = "owner" | "admin" | "editor" | "moderator" | "viewer";

export type OpsDetail = {
  id: string;
  name: string;
  plan: Plan;
  source: "override" | "subscription" | "free";
  suspendedAt: string | null;
  suspendedReason: string | null;
  override: { plan: Plan; until: string | null; reason: string | null; active: boolean } | null;
  members: { userId: string; email: string; role: Role; status: "active" | "suspended"; twoFactor: boolean }[];
};

const REASON_MAX = 300;

/** Midnight at the end of the chosen day in UTC, so "until 1 Dec" includes the whole of 1 Dec. */
function endOfDay(date: string) {
  return `${date}T23:59:59.000Z`;
}

/** The operator's controls for one workspace: suspend, plan override and per-member 2FA reset. */
export function OpsWorkspaceManager({ initial }: { initial: OpsDetail }) {
  const t = useT();
  const locale = useLocale();
  const [detail, setDetail] = useState(initial);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [suspendReason, setSuspendReason] = useState("");
  const [plan, setPlan] = useState<Plan>("pro");
  const [until, setUntil] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [resetting, setResetting] = useState<string | null>(null);

  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });

  /** Runs one operator call, then reloads the detail. Returns whether it worked. */
  async function run(method: string, path: string, body: unknown, done: MessageKey): Promise<boolean> {
    if (pending) return false;
    setPending(true);
    setError(null);
    setMessage("");
    try {
      const response = await fetch(`/api/ops/workspaces/${detail.id}${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) {
        setError((await apiError(response)).message);
        return false;
      }
      const fresh = await fetch(`/api/ops/workspaces/${detail.id}`);
      if (fresh.ok) setDetail((await fresh.json()) as OpsDetail);
      setMessage(t(done));
      return true;
    } catch {
      setError(NETWORK_ERROR);
      return false;
    } finally {
      setPending(false);
    }
  }

  async function suspend(event: FormEvent) {
    event.preventDefault();
    if (await run("POST", "/suspend", { reason: suspendReason }, "ops.suspended")) setSuspendReason("");
  }

  async function saveOverride(event: FormEvent) {
    event.preventDefault();
    const ok = await run("PUT", "/plan-override", { plan, until: until ? endOfDay(until) : "", reason: overrideReason }, "ops.overrideSaved");
    if (ok) {
      setUntil("");
      setOverrideReason("");
    }
  }

  async function reset(userId: string) {
    if (await run("POST", `/members/${userId}/reset-2fa`, null, "ops.twoFactorWasReset")) setResetting(null);
  }

  const override = detail.override;

  return (
    <div className="stack">
      <p className="ops-notice" role="status">
        {message}
      </p>
      {error && <InlineError>{error}</InlineError>}

      <section className="ops-panel" aria-labelledby="ops-suspension">
        <div className="ops-row-head">
          <h2 id="ops-suspension">{t("ops.suspension")}</h2>
          <Badge tone={detail.suspendedAt ? "accent" : "neutral"}>
            {detail.suspendedAt ? t("ops.suspendedBadge") : t("ops.running")}
          </Badge>
        </div>
        {detail.suspendedAt ? (
          <>
            <p className="row-meta">
              {t("ops.suspendedSince", { date: date.format(new Date(detail.suspendedAt)) })}
              {detail.suspendedReason ? ` ${t("ops.reasonIs", { reason: detail.suspendedReason })}` : ""}
            </p>
            <div className="row-actions">
              <Button onClick={() => void run("POST", "/reactivate", null, "ops.reactivated")} aria-busy={pending || undefined}>
                {t("ops.reactivate")}
              </Button>
            </div>
          </>
        ) : (
          <form className="form-stack" onSubmit={suspend}>
            <p className="row-meta">{t("ops.suspendHelp")}</p>
            <TextArea
              label={t("ops.reason")}
              hint={t("ops.reasonHint")}
              value={suspendReason}
              maxLength={REASON_MAX}
              rows={2}
              onChange={(e) => setSuspendReason(e.target.value)}
            />
            <div className="row-actions">
              <Button type="submit" variant="primary" aria-busy={pending || undefined}>
                {t("ops.suspend")}
              </Button>
            </div>
          </form>
        )}
      </section>

      <section className="ops-panel" aria-labelledby="ops-override">
        <div className="ops-row-head">
          <h2 id="ops-override">{t("ops.override")}</h2>
          <Badge tone={detail.source === "override" ? "accent" : "neutral"}>{t(`plan.name.${detail.plan}`)}</Badge>
        </div>
        {override ? (
          <p className="row-meta">
            {override.active
              ? t("ops.overrideActive", { plan: t(`plan.name.${override.plan}`), date: override.until ? date.format(new Date(override.until)) : "-" })
              : t("ops.overrideEnded", { plan: t(`plan.name.${override.plan}`), date: override.until ? date.format(new Date(override.until)) : "-" })}
            {override.reason ? ` ${t("ops.reasonIs", { reason: override.reason })}` : ""}
          </p>
        ) : (
          <p className="row-meta">{t("ops.overrideNone")}</p>
        )}
        <form className="form-stack" onSubmit={saveOverride}>
          <Select label={t("ops.overridePlan")} value={plan} onChange={(e) => setPlan(e.target.value as Plan)}>
            {(["free", "pro", "team"] as const).map((id) => (
              <option key={id} value={id}>
                {t(`plan.name.${id}`)}
              </option>
            ))}
          </Select>
          <TextField label={t("ops.overrideUntil")} hint={t("ops.overrideUntilHint")} type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          <TextArea
            label={t("ops.reason")}
            hint={t("ops.reasonHint")}
            value={overrideReason}
            maxLength={REASON_MAX}
            rows={2}
            onChange={(e) => setOverrideReason(e.target.value)}
          />
          <div className="row-actions">
            <Button type="submit" variant="primary" aria-busy={pending || undefined}>
              {t("ops.overrideSave")}
            </Button>
            {override && (
              <Button onClick={() => void run("DELETE", "/plan-override", null, "ops.overrideCleared")} aria-busy={pending || undefined}>
                {t("ops.overrideClear")}
              </Button>
            )}
          </div>
        </form>
      </section>

      <section className="ops-panel" aria-labelledby="ops-members">
        <h2 id="ops-members">{t("ops.membersTitle")}</h2>
        <p className="row-meta">{t("ops.resetHelp")}</p>
        <ul className="row-list" aria-labelledby="ops-members">
          {detail.members.map((m) => (
            <li key={m.userId} className="ops-member">
              <div className="ops-member-who">
                <span className="ops-member-email">{m.email}</span>
                <span className="row-meta">
                  {t(`role.${m.role}`)} · {t(m.twoFactor ? "ops.twoFactorOn" : "ops.twoFactorOff")}
                </span>
              </div>
              {m.twoFactor &&
                (resetting === m.userId ? (
                  <div className="row-actions">
                    <Button variant="primary" onClick={() => void reset(m.userId)} aria-busy={pending || undefined}>
                      {t("ops.resetConfirm", { email: m.email })}
                    </Button>
                    <Button onClick={() => setResetting(null)}>{t("ops.resetCancel")}</Button>
                  </div>
                ) : (
                  <Button onClick={() => setResetting(m.userId)} aria-label={t("ops.resetFor", { email: m.email })}>
                    {t("ops.reset")}
                  </Button>
                ))}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
