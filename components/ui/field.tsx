import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

type FieldShell = { label: string; hint?: string; error?: string };

function Shell({ id, label, hint, error, children }: FieldShell & { id: string; children: ReactNode }) {
  return (
    <div className="ui-field">
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <p className="ui-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {children}
      {error ? <InlineError id={`${id}-error`}>{error}</InlineError> : null}
    </div>
  );
}

function describedBy(id: string, { hint, error }: FieldShell) {
  const ids = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ");
  return ids || undefined;
}

export function InlineError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p className="ui-error" id={id} role="alert">
      {children}
    </p>
  );
}

export function TextField({ label, hint, error, ...rest }: FieldShell & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error}>
      <input {...rest} id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, { label, hint, error })} />
    </Shell>
  );
}

export function TextArea({ label, hint, error, ...rest }: FieldShell & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error}>
      <textarea {...rest} id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, { label, hint, error })} />
    </Shell>
  );
}

export function Select({ label, hint, error, children, ...rest }: FieldShell & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error}>
      <select {...rest} id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, { label, hint, error })}>
        {children}
      </select>
    </Shell>
  );
}

export function Toggle({ label, ...rest }: { label: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <label className="ui-toggle">
      <input {...rest} type="checkbox" />
      <span>{label}</span>
    </label>
  );
}
