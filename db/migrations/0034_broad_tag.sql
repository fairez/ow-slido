CREATE TABLE "quiz_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interaction_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"option_ids" jsonb NOT NULL,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"elapsed_ms" integer NOT NULL,
	"correct" boolean NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "quiz_answers_one_per_participant" UNIQUE("interaction_id","participant_id"),
	CONSTRAINT "quiz_answers_elapsed" CHECK ("quiz_answers"."elapsed_ms" >= 0),
	CONSTRAINT "quiz_answers_points" CHECK ("quiz_answers"."points" >= 0)
);
--> statement-breakpoint
ALTER TABLE "interactions" DROP CONSTRAINT "interactions_type";--> statement-breakpoint
ALTER TABLE "template_items" DROP CONSTRAINT "template_items_type";--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quiz_answers" ADD CONSTRAINT "quiz_answers_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_answers" ADD CONSTRAINT "quiz_answers_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_type" CHECK ("interactions"."type" in ('poll', 'wordcloud', 'sharedNotes', 'openText', 'rating', 'qa', 'ranking', 'quiz'));--> statement-breakpoint
ALTER TABLE "template_items" ADD CONSTRAINT "template_items_type" CHECK ("template_items"."type" in ('poll', 'wordcloud', 'sharedNotes', 'openText', 'rating', 'qa', 'ranking', 'quiz'));