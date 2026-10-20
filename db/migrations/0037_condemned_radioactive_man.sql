ALTER TABLE "quiz_scores" DROP CONSTRAINT "quiz_scores_nonnegative";--> statement-breakpoint
ALTER TABLE "quiz_scores" ADD COLUMN "correct_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quiz_scores" ADD CONSTRAINT "quiz_scores_nonnegative" CHECK ("quiz_scores"."points" >= 0 and "quiz_scores"."answered_count" >= 0 and "quiz_scores"."correct_count" >= 0 and "quiz_scores"."total_elapsed_ms" >= 0);--> statement-breakpoint
UPDATE "quiz_scores" s SET "correct_count" = c.n FROM (
  SELECT a."participant_id", i."event_id", count(*)::int AS n
  FROM "quiz_answers" a JOIN "interactions" i ON i."id" = a."interaction_id"
  WHERE a."correct" AND i."state" = 'closed'
  GROUP BY a."participant_id", i."event_id"
) c WHERE s."participant_id" = c."participant_id" AND s."event_id" = c."event_id";
