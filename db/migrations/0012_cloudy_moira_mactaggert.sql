CREATE TABLE "shared_note_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_note_votes_one_per_participant" UNIQUE("note_id","participant_id")
);
--> statement-breakpoint
CREATE TABLE "shared_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interaction_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"text" text NOT NULL,
	"author_name" text,
	"status" text DEFAULT 'approved' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_notes_text_length" CHECK (char_length("shared_notes"."text") between 1 and 500),
	CONSTRAINT "shared_notes_status" CHECK ("shared_notes"."status" in ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "shared_note_votes" ADD CONSTRAINT "shared_note_votes_note_id_shared_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."shared_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_note_votes" ADD CONSTRAINT "shared_note_votes_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_notes" ADD CONSTRAINT "shared_notes_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_notes" ADD CONSTRAINT "shared_notes_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shared_notes_interaction_status_idx" ON "shared_notes" USING btree ("interaction_id","status");--> statement-breakpoint
CREATE INDEX "shared_notes_participant_idx" ON "shared_notes" USING btree ("interaction_id","participant_id");