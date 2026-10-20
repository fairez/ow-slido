import type { IconKind } from "@/components/type-icon";

/** A template as `GET /api/templates` returns it. */
export type TemplateSummary = {
  id: string;
  name: string;
  kind: "interaction" | "event";
  items: { type: IconKind; title: string }[];
};
