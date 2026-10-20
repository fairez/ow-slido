import type { ReactNode } from "react";

export type IconKind = "poll" | "wordcloud" | "sharedNotes" | "openText" | "rating" | "qa" | "ranking" | "quiz";

// 16px line icons on currentColor; the type name is always printed next to them.
const PATHS: Record<IconKind, ReactNode> = {
  poll: <path d="M3 13V8M8 13V3M13 13V6" />,
  wordcloud: <path d="M2 5h5M9 5h5M4 8h8M2 11h6M10 11h4" />,
  sharedNotes: <path d="M3 2.5h10v11H3zM5.5 6h5M5.5 8.5h5M5.5 11h3" />,
  openText: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />,
  rating: <path d="m8 2 1.8 3.7 4.1.6-3 2.9.7 4.1L8 11.3l-3.6 2 .7-4.1-3-2.9 4.1-.6z" />,
  ranking: <path d="M3 4h10M3 8h7M3 12h4" />,
  quiz: <path d="M8 2.5v1.5M5.5 2.5h5M8 14a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM8 6.5V9l1.8 1" />,
  qa: <path d="M6 6a2 2 0 1 1 3 1.7c-.7.4-1 .8-1 1.6M8 12v.5M2.5 2.5h11v11h-11z" />,
};

export function TypeIcon({ kind }: { kind: IconKind }) {
  return (
    <svg className="type-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[kind]}
    </svg>
  );
}

export function GripIcon() {
  return (
    <svg className="type-icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="6" cy="4" r="1.2" /><circle cx="10" cy="4" r="1.2" />
      <circle cx="6" cy="8" r="1.2" /><circle cx="10" cy="8" r="1.2" />
      <circle cx="6" cy="12" r="1.2" /><circle cx="10" cy="12" r="1.2" />
    </svg>
  );
}
