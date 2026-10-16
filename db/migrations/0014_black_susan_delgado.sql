CREATE TABLE "rating_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interaction_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"value" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rating_responses_one_per_participant" UNIQUE("interaction_id","participant_id"),
	CONSTRAINT "rating_responses_value_range" CHECK ("rating_responses"."value" between 1 and 10)
);
--> statement-breakpoint
ALTER TABLE "rating_responses" ADD CONSTRAINT "rating_responses_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_responses" ADD CONSTRAINT "rating_responses_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;