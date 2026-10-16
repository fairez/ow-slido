CREATE TABLE "open_text_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interaction_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"text" text NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"highlighted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_text_responses_text_length" CHECK (char_length("open_text_responses"."text") between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "open_text_responses" ADD CONSTRAINT "open_text_responses_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_text_responses" ADD CONSTRAINT "open_text_responses_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "open_text_responses_interaction_idx" ON "open_text_responses" USING btree ("interaction_id","created_at");--> statement-breakpoint
CREATE INDEX "open_text_responses_participant_idx" ON "open_text_responses" USING btree ("interaction_id","participant_id");