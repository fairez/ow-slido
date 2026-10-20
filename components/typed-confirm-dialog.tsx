"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { InlineError, TextField } from "@/components/ui/field";
import { useT } from "@/lib/i18n/client";

type Props = {
  open: boolean;
  title: string;
  /** What will be lost; shown above the field. */
  body: string;
  /** The text that must be typed to enable the action (compared after trimming). */
  expected: string;
  confirmLabel: string;
  /** Resolves to an error message, or null when it worked (the caller then closes the dialog). */
  onConfirm: () => Promise<string | null>;
  onClose: () => void;
};

function Body({ body, expected, confirmLabel, onConfirm, onClose }: Omit<Props, "open" | "title">) {
  const t = useT();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const matches = typed.trim() === expected;

  // The button stays enabled (aria-disabled) so focus never leaves the dialog while it waits.
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!matches || pending) return;
    setPending(true);
    setError(null);
    setError(await onConfirm());
    setPending(false);
  }

  return (
    <form onSubmit={submit} className="form-stack">
      <p>{body}</p>
      <TextField
        label={t("typedConfirm.label", { name: expected })}
        name="confirmation"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      {error && <InlineError>{error}</InlineError>}
      <div className="row-actions">
        <Button onClick={onClose}>{t("typedConfirm.cancel")}</Button>
        <Button type="submit" variant="primary" aria-disabled={!matches || undefined} aria-busy={pending || undefined}>
          {confirmLabel}
        </Button>
      </div>
    </form>
  );
}

/** Irreversible action behind a typed confirmation: the user must type `expected` before it runs. */
export function TypedConfirmDialog({ open, title, onClose, ...rest }: Props) {
  return (
    <Dialog open={open} title={title} onClose={onClose}>
      <Body {...rest} onClose={onClose} />
    </Dialog>
  );
}
