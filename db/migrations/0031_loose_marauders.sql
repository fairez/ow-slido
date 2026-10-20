ALTER TABLE "interactions" DROP CONSTRAINT "interactions_type";--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_type" CHECK ("interactions"."type" in ('poll', 'wordcloud', 'sharedNotes', 'openText', 'rating', 'qa'));--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "interaction_id" uuid;--> statement-breakpoint
-- One Q&A interaction per event that has questions or no interaction yet; it is live only when the event had no live interaction.
WITH created AS (
  INSERT INTO "interactions" ("id", "event_id", "type", "title", "state", "position", "config")
  SELECT
    gen_random_uuid(),
    e."id",
    'qa',
    'Q&A',
    CASE WHEN EXISTS (SELECT 1 FROM "interactions" i WHERE i."event_id" = e."id" AND i."state" = 'live') THEN 'paused' ELSE 'live' END,
    COALESCE((SELECT max(i."position") + 1 FROM "interactions" i WHERE i."event_id" = e."id"), 0),
    jsonb_build_object('prompt', 'Ask a question', 'moderation', e."moderation_mode")
  FROM "events" e
  WHERE EXISTS (SELECT 1 FROM "questions" q WHERE q."event_id" = e."id")
     OR NOT EXISTS (SELECT 1 FROM "interactions" i WHERE i."event_id" = e."id")
  RETURNING "id", "event_id"
)
UPDATE "questions" q SET "interaction_id" = created."id" FROM created WHERE q."event_id" = created."event_id";--> statement-breakpoint
ALTER TABLE "questions" ALTER COLUMN "interaction_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "questions_interaction_idx" ON "questions" USING btree ("interaction_id");
