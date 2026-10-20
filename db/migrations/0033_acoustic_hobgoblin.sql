CREATE TABLE "ranking_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interaction_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"order" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ranking_responses_one_per_participant" UNIQUE("interaction_id","participant_id")
);
--> statement-breakpoint
ALTER TABLE "interactions" DROP CONSTRAINT "interactions_type";--> statement-breakpoint
ALTER TABLE "template_items" DROP CONSTRAINT "template_items_type";--> statement-breakpoint
ALTER TABLE "ranking_responses" ADD CONSTRAINT "ranking_responses_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_responses" ADD CONSTRAINT "ranking_responses_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_type" CHECK ("interactions"."type" in ('poll', 'wordcloud', 'sharedNotes', 'openText', 'rating', 'qa', 'ranking'));--> statement-breakpoint
ALTER TABLE "template_items" ADD CONSTRAINT "template_items_type" CHECK ("template_items"."type" in ('poll', 'wordcloud', 'sharedNotes', 'openText', 'rating', 'qa', 'ranking'));