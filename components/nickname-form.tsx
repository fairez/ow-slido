"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { NICKNAME_MAX } from "@/lib/quiz-limits";
import { useT } from "@/lib/i18n/client";
import { NETWORK_ERROR, SERVER_ERROR } from "@/lib/copy";

/**
 * The quiz display name. It is saved through `PUT /api/events/[id]/nickname`, which rejects empty, taken and
 * filtered names and answers with a message in the participant's language.
 */
export function NicknameForm({
  eventId,
  initial,
  keepName,
  onSaved,
  onCancel,
}: {
  eventId: string;
  initial: string | null;
  /** When the participant already has a name, the label of the button that keeps it. */
  keepName?: string;
  onSaved: (nickname: string) => void;
  onCancel?: () => void;
}) {
  const t = useT();
  const [value, setValue] = useState(initial ?? "");
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  // A form the participant opened themselves takes focus; the first-time one must not pop the keyboard.
  const editing = initial !== null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (!value.trim()) {
      setError(t("api.nicknameEmpty"));
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const res = await fetch(`/api/events/${eventId}/nickname`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nickname: value }),
      });
      const body = (await res.json().catch(() => ({}))) as { nickname?: string; error?: string };
      if (res.ok && body.nickname) onSaved(body.nickname);
      else setError(body.error ?? SERVER_ERROR);
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="nickname-form" onSubmit={submit} noValidate>
      {!editing && (
        <>
          <h3 className="nickname-title">{t("quiz.nicknameTitle")}</h3>
          <p className="nickname-body">{t("quiz.nicknameBody", { max: NICKNAME_MAX })}</p>
        </>
      )}
      <TextField
        label={t("quiz.nicknameLabel")}
        hint={editing ? t("quiz.nicknameBody", { max: NICKNAME_MAX }) : undefined}
        value={value}
        maxLength={NICKNAME_MAX}
        autoComplete="nickname"
        autoFocus={editing}
        error={error}
        onChange={(e) => setValue(e.target.value)}
      />
      <p className="field-meta">{t("quiz.nicknameLocksNote")}</p>
      <div className="nickname-actions">
        <Button type="submit" variant="primary" busy={saving}>
          {saving ? t("quiz.nicknameSaving") : t("quiz.nicknameSave")}
        </Button>
        {onCancel && (
          <Button type="button" variant="quiet" onClick={onCancel}>
            {t("quiz.nicknameCancel", { name: keepName ?? "" })}
          </Button>
        )}
      </div>
    </form>
  );
}
