CREATE TABLE "wordcloud_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interaction_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"normalized_word" text NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wordcloud_entries" ADD CONSTRAINT "wordcloud_entries_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wordcloud_entries" ADD CONSTRAINT "wordcloud_entries_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wordcloud_entries_interaction_idx" ON "wordcloud_entries" USING btree ("interaction_id");--> statement-breakpoint
CREATE INDEX "wordcloud_entries_participant_idx" ON "wordcloud_entries" USING btree ("interaction_id","participant_id");