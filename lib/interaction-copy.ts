import { randomUUID } from "node:crypto";
import { isNewInteractionType, newInteractionConfig, type RankingConfig } from "@/lib/interaction-config";
import { pollConfig, type PollConfig } from "@/lib/polls";
import { wordcloudConfig, type WordcloudConfig } from "@/lib/wordclouds";

/**
 * The config a copy of an interaction starts with (duplicate, template save, template use): the settings and
 * the options are kept, defaults fill gaps, and poll options get fresh ids so a copy never shares an id with
 * its source. Nothing here reads responses, so a copy cannot carry any.
 */
export function copyConfig(type: string, title: string, config: unknown): Record<string, unknown> {
  if (type === "ranking") {
    const ranking = newInteractionConfig("ranking", (config ?? {}) as Partial<RankingConfig>);
    return { ...ranking, options: ranking.options.map((o) => ({ ...o, id: randomUUID() })) };
  }
  if (isNewInteractionType(type)) return newInteractionConfig(type, (config ?? {}) as never);
  if (type === "wordcloud") return wordcloudConfig((config ?? {}) as Partial<WordcloudConfig>, title);
  const poll = pollConfig((config ?? {}) as Partial<PollConfig>);
  return { ...poll, options: poll.options.map((o) => ({ ...o, id: randomUUID() })) };
}
