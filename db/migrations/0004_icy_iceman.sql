CREATE TABLE "interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"position" integer NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interactions_type" CHECK ("interactions"."type" in ('poll', 'wordcloud')),
	CONSTRAINT "interactions_state" CHECK ("interactions"."state" in ('draft', 'live', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interactions_event_position_idx" ON "interactions" USING btree ("event_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "interactions_one_live_per_event" ON "interactions" USING btree ("event_id") WHERE "interactions"."state" = 'live';