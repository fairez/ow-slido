"use client";

import QRCode from "qrcode";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { InlineError, TextField } from "@/components/ui/field";
import { useT } from "@/lib/i18n/client";

type Phase = "idle" | "setup" | "codes";

type Props = {
  email: string;
  available: boolean;
  enabled: boolean;
  recoveryCodesLeft: number;
};

/** Groups the setup key in fours so it can be read aloud and typed; authenticator apps ignore the spaces. */
const groupKey = (secret: string) => secret.match(/.{1,4}/g)?.join(" ") ?? secret;

export function SecuritySettings({ email, available, enabled: initialEnabled, recoveryCodesLeft: initialLeft }: Props) {
  const t = useT();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [codesLeft, setCodesLeft] = useState(initialLeft);
  const [phase, setPhase] = useState<Phase>("idle");
  const [justTurnedOff, setJustTurnedOff] = useState(false);
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  // A screen change moves focus to its heading, so a screen reader starts reading at the new content.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [phase, enabled]);

  /** Posts JSON; returns the parsed body on success or sets the error and returns null. */
  async function post(path: string, payload?: unknown): Promise<Record<string, unknown> | null> {
    if (pending) return null;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
      });
      const body = await response.json().catch(() => null);
      if (response.ok) return body ?? {};
      setError(body?.error ?? t("error.server"));
    } catch {
      setError(t("error.network"));
    } finally {
      setPending(false);
    }
    return null;
  }

  async function startSetup() {
    const body = await post("/api/auth/2fa/enrol");
    if (!body || typeof body.secret !== "string" || typeof body.uri !== "string") return;
    // Drawn here from the otpauth URI: the secret never goes to a QR service.
    let qr: string;
    try {
      qr = await QRCode.toDataURL(body.uri, { margin: 2, width: 224, errorCorrectionLevel: "M" });
    } catch {
      setError(t("error.server"));
      return;
    }
    setSetup({ secret: body.secret, qr });
    setJustTurnedOff(false);
    setPhase("setup");
  }

  async function confirmSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = new FormData(event.currentTarget).get("code");
    const body = await post("/api/auth/2fa/confirm", { code });
    if (!body || !Array.isArray(body.recoveryCodes)) return;
    setRecoveryCodes(body.recoveryCodes as string[]);
    setSetup(null);
    setCopyNote(null);
    setEnabled(true);
    setPhase("codes");
  }

  function cancelSetup() {
    setSetup(null);
    setError(null);
    setPhase("idle");
  }

  function finishCodes() {
    setCodesLeft(recoveryCodes.length);
    setRecoveryCodes([]);
    setCopyNote(null);
    setPhase("idle");
  }

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join("\n"));
      setCopyNote(t("security.codes.copied"));
    } catch {
      setCopyNote(t("security.codes.copyFailed"));
    }
  }

  function downloadCodes() {
    const text = t("security.codes.file", { email, codes: recoveryCodes.join("\n") });
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "ow-slido-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function disable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = await post("/api/auth/2fa/disable", { password: form.get("password"), code: form.get("code") });
    if (!body) return;
    setEnabled(false);
    setCodesLeft(0);
    setJustTurnedOff(true);
  }

  if (!available && !enabled) {
    return (
      <section aria-labelledby="security-status">
        <h2 id="security-status" ref={headingRef} tabIndex={-1}>
          {t("security.status.title")}
        </h2>
        <p className="security-status">{t("security.status.off")}</p>
        <p className="ui-hint">{t("security.unavailable")}</p>
      </section>
    );
  }

  if (phase === "setup" && setup) {
    return (
      <section aria-labelledby="security-setup" className="security-panel">
        <h2 id="security-setup" ref={headingRef} tabIndex={-1}>
          {t("security.setup.title")}
        </h2>
        <ol className="security-steps">
          <li>
            <p>{t("security.setup.stepScan")}</p>
            {/* The QR is a data URL drawn above; the key below carries the same information as text. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="security-qr" src={setup.qr} width={224} height={224} alt={t("security.setup.qrAlt")} />
          </li>
          <li>
            <p>{t("security.setup.stepKey")}</p>
            <p className="security-key">
              <span className="security-key-label">{t("security.setup.keyLabel")}</span>
              <code>{groupKey(setup.secret)}</code>
            </p>
          </li>
          <li>
            <p>{t("security.setup.stepCode")}</p>
            <form method="post" onSubmit={confirmSetup} className="entry-form">
              <TextField
                label={t("security.setup.codeLabel")}
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                spellCheck={false}
                className="code-input"
                required
              />
              {error && <InlineError>{error}</InlineError>}
              <div className="security-actions">
                <Button type="submit" variant="primary" busy={pending}>
                  {pending ? t("security.loading") : t("security.setup.confirm")}
                </Button>
                <Button variant="quiet" onClick={cancelSetup}>
                  {t("security.setup.cancel")}
                </Button>
              </div>
            </form>
          </li>
        </ol>
      </section>
    );
  }

  if (phase === "codes") {
    return (
      <section aria-labelledby="security-codes" className="security-panel">
        <h2 id="security-codes" ref={headingRef} tabIndex={-1}>
          {t("security.codes.title")}
        </h2>
        <p>{t("security.codes.lead")}</p>
        <ul className="security-codes" aria-label={t("security.codes.list")}>
          {recoveryCodes.map((code) => (
            <li key={code}>
              <code>{code}</code>
            </li>
          ))}
        </ul>
        <div className="security-actions">
          <Button onClick={copyCodes}>{t("security.codes.copy")}</Button>
          <Button onClick={downloadCodes}>{t("security.codes.download")}</Button>
        </div>
        <p className="ui-hint" role="status">
          {copyNote}
        </p>
        <Button variant="primary" onClick={finishCodes}>
          {t("security.codes.done")}
        </Button>
      </section>
    );
  }

  if (enabled) {
    return (
      <div className="stack">
        <section aria-labelledby="security-status">
          <h2 id="security-status" ref={headingRef} tabIndex={-1}>
            {t("security.status.title")}
          </h2>
          <p className="security-status">{t("security.status.on")}</p>
          <p className="ui-hint">{t("security.status.codesLeft", { count: codesLeft })}</p>
        </section>
        <section aria-labelledby="security-disable">
          <h2 id="security-disable">{t("security.disable.title")}</h2>
          <p className="entry-lead">{t("security.disable.lead")}</p>
          <form method="post" onSubmit={disable} className="entry-form security-form">
            <TextField
              label={t("security.disable.password")}
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
            <TextField
              label={t("security.disable.code")}
              name="code"
              type="text"
              autoComplete="one-time-code"
              spellCheck={false}
              required
            />
            {error && <InlineError>{error}</InlineError>}
            <Button type="submit" busy={pending}>
              {pending ? t("security.loading") : t("security.disable.submit")}
            </Button>
          </form>
        </section>
      </div>
    );
  }

  return (
    <section aria-labelledby="security-status">
      <h2 id="security-status" ref={headingRef} tabIndex={-1}>
        {t("security.status.title")}
      </h2>
      <p className="security-status" role={justTurnedOff ? "status" : undefined}>
        {justTurnedOff ? t("security.status.justOff") : t("security.status.off")}
      </p>
      {error && <InlineError>{error}</InlineError>}
      <Button variant="primary" busy={pending} onClick={startSetup}>
        {pending ? t("security.loading") : t("security.setup.start")}
      </Button>
    </section>
  );
}
