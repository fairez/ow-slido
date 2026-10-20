CREATE TABLE "quiz_scores" (
	"event_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"answered_count" integer DEFAULT 0 NOT NULL,
	"total_elapsed_ms" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "quiz_scores_event_id_participant_id_pk" PRIMARY KEY("event_id","participant_id"),
	CONSTRAINT "quiz_scores_nonnegative" CHECK ("quiz_scores"."points" >= 0 and "quiz_scores"."answered_count" >= 0 and "quiz_scores"."total_elapsed_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "quiz_scores" ADD CONSTRAINT "quiz_scores_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_scores" ADD CONSTRAINT "quiz_scores_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;