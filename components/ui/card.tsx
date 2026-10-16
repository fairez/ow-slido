import type { HTMLAttributes, ReactNode } from "react";

export function Card({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <section {...rest} className={["ui-card", className].filter(Boolean).join(" ")} />;
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "accent"; children: ReactNode }) {
  return (
    <span className="ui-badge" data-tone={tone}>
      {children}
    </span>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="ui-empty">
      <p className="ui-empty-title">{title}</p>
      {children ? <p>{children}</p> : null}
    </div>
  );
}
