CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"join_code" text NOT NULL,
	"moderation_mode" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_join_code_unique" UNIQUE("join_code"),
	CONSTRAINT "events_name_length" CHECK (char_length("events"."name") between 1 and 80),
	CONSTRAINT "events_join_code_format" CHECK ("events"."join_code" ~ '^[0-9]{4,6}$'),
	CONSTRAINT "events_moderation_mode" CHECK ("events"."moderation_mode" in ('open', 'moderated')),
	CONSTRAINT "events_dates_order" CHECK ("events"."ends_at" >= "events"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;