ALTER TABLE "events" ADD COLUMN "peak_participants" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "first_login_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "first_interaction_live_at" timestamp with time zone;