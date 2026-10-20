ALTER TABLE "events" ADD COLUMN "audience_locale" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_audience_locale" CHECK ("events"."audience_locale" in ('en', 'id'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_locale" CHECK ("users"."locale" in ('en', 'id'));