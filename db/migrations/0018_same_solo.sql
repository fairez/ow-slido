ALTER TABLE "interactions" DROP CONSTRAINT "interactions_state";--> statement-breakpoint
ALTER TABLE "shared_notes" DROP CONSTRAINT "shared_notes_text_length";--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_state" CHECK ("interactions"."state" in ('draft', 'live', 'paused', 'closed'));--> statement-breakpoint
ALTER TABLE "shared_notes" ADD CONSTRAINT "shared_notes_text_length" CHECK (char_length("shared_notes"."text") between 1 and 5000);