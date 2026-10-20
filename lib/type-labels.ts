import type { MessageKey } from "@/lib/i18n";
import type { IconKind } from "@/components/type-icon";

/** Message key of the name shown for each interaction type. */
export const TYPE_LABELS: Record<IconKind, MessageKey> = {
  qa: "pollMgr.type.qa",
  poll: "pollMgr.type.poll",
  wordcloud: "pollMgr.type.wordcloud",
  sharedNotes: "pollMgr.type.sharedNotes",
  openText: "pollMgr.type.openText",
  rating: "pollMgr.type.rating",
  ranking: "pollMgr.type.ranking",
  quiz: "pollMgr.type.quiz",
};
