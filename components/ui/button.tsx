import type { ButtonHTMLAttributes, Ref } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "quiet";
  busy?: boolean;
  ref?: Ref<HTMLButtonElement>;
};

export function Button({ variant = "secondary", busy = false, disabled, className, children, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      data-variant={variant}
      className={["ui-button", className].filter(Boolean).join(" ")}
    >
      {children}
    </button>
  );
}
