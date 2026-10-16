CREATE TABLE "poll_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interaction_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"option_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poll_votes_one_per_participant" UNIQUE("interaction_id","participant_id")
);
--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;