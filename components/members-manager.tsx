"use client";

import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { InlineError, Select, TextField } from "@/components/ui/field";
import { ROLES, type Role } from "@/lib/auth/permissions";
import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n";

export type MemberRow = {
  userId: string;
  email: string;
  role: Role;
  status: "active" | "suspended";
  joinedAt: string;
  lastLoginAt: string | null;
};
export type InvitationRow = { id: string; email: string; role: string; status: string; expiresAt: string };

const INVITABLE: Role[] = ["admin", "editor", "moderator", "viewer"];
const day = (iso: string) => iso.slice(0, 10);

type Call = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

export function MembersManager({
  selfId,
  actorRole,
  initialMembers,
  initialInvitations,
}: {
  selfId: string;
  actorRole: Role;
  initialMembers: MemberRow[];
  initialInvitations: InvitationRow[];
}) {
  const t = useT();
  const roleLabel = (role: string) => t(`role.${role}` as MessageKey);
  const [members, setMembers] = useState(initialMembers);
  const [invitations, setInvitations] = useState(initialInvitations);
  const [pageError, setPageError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [invited, setInvited] = useState<{ email: string; link: string; emailSent: boolean } | null>(null);
  const [removing, setRemoving] = useState<MemberRow | null>(null);
  const [resetting, setResetting] = useState<MemberRow | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [temporary, setTemporary] = useState<{ email: string; password: string } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const assignable = actorRole === "owner" ? ROLES : ROLES.filter((r) => r !== "owner");
  const pending = invitations.filter((i) => i.status === "pending" && new Date(i.expiresAt) > new Date());

  async function call(method: string, url: string, body?: unknown): Promise<Call> {
    try {
      const response = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.ok) return { ok: true, data };
      return { ok: false, error: typeof data.error === "string" ? data.error : t("error.server") };
    } catch {
      return { ok: false, error: t("error.network") };
    }
  }

  async function reload() {
    const [m, i] = await Promise.all([call("GET", "/api/members"), call("GET", "/api/invitations")]);
    if (m.ok) setMembers(m.data.members as MemberRow[]);
    if (i.ok) setInvitations(i.data.invitations as InvitationRow[]);
    if (!m.ok || !i.ok) setPageError(t("members.loadFailed"));
  }

  /** Runs an action that reports errors on the page, then refreshes both lists. */
  async function act(key: string, method: string, url: string, body?: unknown) {
    setBusy(key);
    setPageError(null);
    const result = await call(method, url, body);
    if (!result.ok) setPageError(result.error);
    await reload();
    setBusy(null);
    return result.ok;
  }

  async function sendInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email")).trim();
    setBusy("invite");
    setInviteError(null);
    const result = await call("POST", "/api/invitations", { email, role: form.get("role") });
    setBusy(null);
    if (!result.ok) {
      setInviteError(result.error);
      return;
    }
    setInviting(false);
    setInvited({ email, link: String(result.data.link), emailSent: result.data.emailSent === true });
    await reload();
  }

  async function confirmRemove() {
    if (!removing) return;
    setBusy("remove");
    setDialogError(null);
    const result = await call("DELETE", `/api/members/${removing.userId}`);
    setBusy(null);
    if (!result.ok) {
      setDialogError(result.error);
      return;
    }
    setRemoving(null);
    await reload();
    headingRef.current?.focus();
  }

  async function confirmReset() {
    if (!resetting) return;
    setBusy("reset");
    setDialogError(null);
    const result = await call("POST", `/api/members/${resetting.userId}/password`);
    setBusy(null);
    if (!result.ok) {
      setDialogError(result.error);
      return;
    }
    setTemporary({ email: resetting.email, password: String(result.data.temporaryPassword) });
    setResetting(null);
  }

  async function revoke(invite: InvitationRow) {
    await act(`revoke:${invite.id}`, "DELETE", `/api/invitations/${invite.id}`);
    headingRef.current?.focus();
  }

  return (
    <div className="stack">
      <section aria-labelledby="members-heading">
        <div className="section-head">
          <h2 id="members-heading" ref={headingRef} tabIndex={-1}>
            {t("members.listTitle")}
          </h2>
          <Button
            variant="primary"
            onClick={() => {
              setInviteError(null);
              setInviting(true);
            }}
          >
            {t("members.invite")}
          </Button>
        </div>
        {pageError && <InlineError>{pageError}</InlineError>}
        <ul className="row-list" aria-busy={busy !== null || undefined}>
          {members.map((m) => {
            const isSelf = m.userId === selfId;
            const canManage = !isSelf && (m.role !== "owner" || actorRole === "owner");
            return (
              <li key={m.userId} className="member-row" data-status={m.status}>
                <div className="member-main">
                  <p className="member-email">{m.email}</p>
                  <p className="row-meta">
                    {m.lastLoginAt ? t("members.lastLogin", { date: day(m.lastLoginAt) }) : t("members.neverLoggedIn")}
                  </p>
                </div>
                <div className="member-tags">
                  {isSelf && <Badge tone="accent">{t("common.you")}</Badge>}
                  {m.status === "suspended" && <Badge>{t("members.status.suspended")}</Badge>}
                  {!canManage && <Badge>{roleLabel(m.role)}</Badge>}
                </div>
                {canManage && (
                  <div className="member-actions">
                    <select
                      className="member-role"
                      aria-label={t("members.roleFor", { email: m.email })}
                      value={m.role}
                      disabled={busy === `role:${m.userId}`}
                      onChange={(e) => void act(`role:${m.userId}`, "PATCH", `/api/members/${m.userId}`, { role: e.target.value })}
                    >
                      {assignable.map((r) => (
                        <option key={r} value={r}>
                          {roleLabel(r)}
                        </option>
                      ))}
                    </select>
                    <div className="row-actions row-actions-quiet">
                      <Button
                        variant="quiet"
                        busy={busy === `status:${m.userId}`}
                        aria-label={t(m.status === "active" ? "members.suspendFor" : "members.reactivateFor", { email: m.email })}
                        onClick={() =>
                          void act(`status:${m.userId}`, "PATCH", `/api/members/${m.userId}`, {
                            status: m.status === "active" ? "suspended" : "active",
                          })
                        }
                      >
                        {t(m.status === "active" ? "members.suspend" : "members.reactivate")}
                      </Button>
                      <Button
                        variant="quiet"
                        aria-label={t("members.resetPasswordFor", { email: m.email })}
                        onClick={() => {
                          setDialogError(null);
                          setResetting(m);
                        }}
                      >
                        {t("members.resetPassword")}
                      </Button>
                      <Button
                        variant="quiet"
                        aria-label={t("members.removeFor", { email: m.email })}
                        onClick={() => {
                          setDialogError(null);
                          setRemoving(m);
                        }}
                      >
                        {t("members.remove")}
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="invites-heading">
        <h2 id="invites-heading">{t("members.invitesTitle")}</h2>
        {pending.length === 0 ? (
          <EmptyState title={t("members.invitesEmpty")}>{t("members.invitesEmptyBody")}</EmptyState>
        ) : (
          <ul className="row-list">
            {pending.map((i) => (
              <li key={i.id} className="member-row">
                <div className="member-main">
                  <p className="member-email">{i.email}</p>
                  <p className="row-meta">
                    {roleLabel(i.role)} · {t("members.expires", { date: day(i.expiresAt) })}
                  </p>
                </div>
                <div className="member-actions">
                  <Button
                    variant="quiet"
                    busy={busy === `revoke:${i.id}`}
                    aria-label={t("members.revokeFor", { email: i.email })}
                    onClick={() => void revoke(i)}
                  >
                    {t("members.revoke")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog open={inviting} title={t("members.invite")} onClose={() => setInviting(false)}>
        <form onSubmit={sendInvite} className="form-stack">
          <TextField label={t("members.inviteEmail")} name="email" type="email" autoComplete="off" required />
          <Select label={t("members.inviteRole")} name="role" defaultValue="viewer">
            {INVITABLE.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </Select>
          {inviteError && <InlineError>{inviteError}</InlineError>}
          <div className="row-actions">
            <Button type="submit" variant="primary" busy={busy === "invite"}>
              {t("members.inviteSend")}
            </Button>
            <Button onClick={() => setInviting(false)}>{t("members.cancel")}</Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={invited !== null} title={t("members.inviteSentTitle")} onClose={() => setInvited(null)}>
        {invited && (
          <div className="form-stack">
            <p>{t(invited.emailSent ? "members.inviteEmailed" : "members.inviteNotEmailed", { email: invited.email })}</p>
            <CopyField label={t("members.inviteLink")} value={invited.link} />
            <div className="row-actions">
              <Button variant="primary" onClick={() => setInvited(null)}>
                {t("members.done")}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog
        open={removing !== null}
        title={t("members.removeTitle", { email: removing?.email ?? "" })}
        onClose={() => setRemoving(null)}
      >
        <div className="form-stack">
          <p>{t("members.removeBody")}</p>
          {dialogError && <InlineError>{dialogError}</InlineError>}
          <div className="row-actions">
            <Button variant="primary" busy={busy === "remove"} onClick={() => void confirmRemove()}>
              {t("members.removeConfirm")}
            </Button>
            <Button onClick={() => setRemoving(null)}>{t("members.cancel")}</Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={resetting !== null}
        title={t("members.resetTitle", { email: resetting?.email ?? "" })}
        onClose={() => setResetting(null)}
      >
        <div className="form-stack">
          <p>{t("members.resetBody")}</p>
          {dialogError && <InlineError>{dialogError}</InlineError>}
          <div className="row-actions">
            <Button variant="primary" busy={busy === "reset"} onClick={() => void confirmReset()}>
              {t("members.resetConfirm")}
            </Button>
            <Button onClick={() => setResetting(null)}>{t("members.cancel")}</Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={temporary !== null} title={t("members.tempTitle")} onClose={() => setTemporary(null)}>
        {temporary && (
          <div className="form-stack">
            <p>{t("members.tempBody", { email: temporary.email })}</p>
            <CopyField label={t("members.tempLabel")} value={temporary.password} />
            <div className="row-actions">
              <Button variant="primary" onClick={() => setTemporary(null)}>
                {t("members.done")}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

/** A read-only value that is selected on focus, with a copy button and a spoken confirmation. */
function CopyField({ label, value }: { label: string; value: string }) {
  const t = useT();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="copy-field">
      <div className="copy-row">
        <TextField label={label} value={value} readOnly onFocus={(e) => e.currentTarget.select()} />
        <Button onClick={() => void copy()}>{t("members.copy")}</Button>
      </div>
      <p className="row-meta" role="status">
        {state === "copied" ? t("members.copied") : state === "failed" ? t("members.copyFailed") : ""}
      </p>
    </div>
  );
}
